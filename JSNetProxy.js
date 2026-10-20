
const _hostRegex = new RegExp( /(https?:\/\/[^/]+)/,"i");
window._replaceHost = function(str){
	if (! str)
		return str;
	if (window._ProxyAppendURL) {
		const encodedOrig = str;
		if (str.includes("?"))
			str +="&";
		else
			str +="?";
		str += "__OU=" + encodeURIComponent(encodedOrig);
	}

	if (window._NoTilde)
		str = str.replace("~","_")
	return str.replace(_hostRegex,window._ProxyBase);
}
// ---------------------------------------------------------------------------
// Offline hardening: the downloaded tour must never talk to the internet.
// - analytics / tracking hosts are silently dropped (fetch, XHR, sendBeacon, Image)
// - navigator.sendBeacon to any other origin is dropped (it is only used for telemetry)
// - remote <img>.src set directly (new Image().src=...) is routed to the local server
// The page also gets a same-origin Content-Security-Policy from matterport-dl.py as a backstop.
// ---------------------------------------------------------------------------
window._BlockedHostRegex = /(^|\.)(events\.matterport\.com|segment\.io|segment\.com|google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|criteo\.com|criteo\.net|sentry\.io|ingest\.sentry\.io|nr-data\.net|newrelic\.com|datadoghq\.com|datadoghq\.eu|hotjar\.com|hotjar\.io|mixpanel\.com|amplitude\.com|fullstory\.com|clarity\.ms|launchdarkly\.com|facebook\.net|facebook\.com|linkedin\.com|licdn\.com)$/i;
window._mpdlBlockedSeen = {};
window._mpdlParseUrl = function (url) {
	try { return new URL(url, window.location.href); } catch (e) { return null; }
};
window._isBlockedUrl = function (url) {
	if (!url) return false;
	const u = window._mpdlParseUrl(url.toString());
	if (!u || u.origin === window.location.origin) return false;
	if (!/^(https?|wss?):$/.test(u.protocol)) return false;
	if (!window._BlockedHostRegex.test(u.hostname)) return false;
	if (!window._mpdlBlockedSeen[u.hostname]) {
		window._mpdlBlockedSeen[u.hostname] = 1;
		console.info("[JSNetProxy] blocked outbound request to " + u.hostname);
	}
	return true;
};
window._isRemoteUrl = function (url) {
	const u = window._mpdlParseUrl(url);
	return !!u && /^https?:$/.test(u.protocol) && u.origin !== window.location.origin;
};

window.nv_XMLHttpRequest = new Proxy(XMLHttpRequest, {
	construct: function (target, args) {
		const originalRequest = new target();
		const prototypeDescriptors = Object.getOwnPropertyDescriptors(
			target.prototype
		)
		for (const propertyName in prototypeDescriptors) {
			Reflect.defineProperty(
				originalRequest,
				propertyName,
				prototypeDescriptors[propertyName]
			)
		}
		return new Proxy(originalRequest, {
			get: (target, name, trap) => {
				
				
				if (typeof target[name] === 'function') {
				  return (...args) => {
					switch (name) {
					  case 'open':
						if (args.length > 1) {
							if (window._isBlockedUrl(args[1])) {
								target._mpdlBlocked = true;
								args[0] = "GET";
								args[1] = "data:,";
							} else
								args[1] = window._replaceHost(args[1]);
						}
						break;
					  case 'send':
						if (target._mpdlBlocked)
							return undefined; // never sent
						break;
		
					  default:
						break;
					}
		
					return target[name].apply(target, args);
				  }
				}
		
				
				return target[name];
			  },
			set: function (target, prop, value) {
				Reflect.set(target, prop, value) // or target[prop] = value
				return true;
			},
		})
	}
})

var oReq = new XMLHttpRequest();

window.nv_fetch = new Proxy(window.fetch, {
	apply: function (target, that, args) {
		if (args.length > 0 && args[0] && window._isBlockedUrl(typeof args[0] !== 'string' && args[0].url ? args[0].url : args[0].toString()))
			return Promise.resolve(new Response(null, { status: 204 }));
		if (args.length > 0 && args[0])
			if (typeof args[0] !== 'string' && args[0].url){
				const newUrl = window._replaceHost( args[0].url );
				if (newUrl != args[0].url)
					args[0] = new Request(newUrl, args[0]);
			}
			else
				args[0] = window._replaceHost(args[0].toString());
		return target.apply(that, args);
	},
});

window.XMLHttpRequest = window.nv_XMLHttpRequest;
window.fetch = window.nv_fetch;
window.oldAppendChild = Element.prototype.appendChild;
Element.prototype.appendChild = function() {
	if (arguments.length > 0) {
		if ( (arguments[0]?.tagName == "SCRIPT" || arguments[0]?.tagName == "IMG") && arguments[0].src) {
			if (window._isBlockedUrl(arguments[0].src))
				return arguments[0]; // drop tracking scripts / pixels
			arguments[0].src = window._replaceHost(arguments[0].src);
		}
		else if ( arguments[0]?.tagName == "DIV" && arguments[0].style?.backgroundImage?.startsWith("url"))
			arguments[0].style.backgroundImage = window._replaceHost(arguments[0].style?.backgroundImage);
	}
    return window.oldAppendChild.apply(this, arguments);
};

// sendBeacon: telemetry only, never let it leave this origin
if (navigator.sendBeacon) {
	const _origBeacon = navigator.sendBeacon.bind(navigator);
	navigator.sendBeacon = function (url, data) {
		const u = window._mpdlParseUrl(url);
		if (!u || u.origin !== window.location.origin) {
			window._isBlockedUrl(url);
			return true; // pretend it was queued
		}
		return _origBeacon(url, data);
	};
}

// new Image().src = "https://..." (tracking pixels, or images never appended to the DOM)
(function () {
	const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
	if (!desc || !desc.set) return;
	Object.defineProperty(HTMLImageElement.prototype, "src", {
		configurable: true,
		enumerable: desc.enumerable,
		get: desc.get,
		set: function (v) {
			if (window._isBlockedUrl(v)) return;
			if (typeof v === "string" && window._isRemoteUrl(v)) v = window._replaceHost(v);
			desc.set.call(this, v);
		},
	});
})();

console.log("PROXY IN PLACE (external connections blocked)");

/*
For react you may run into an issue:
reactCont=reactCont.replace("(t.src=s.src)","(t.src=\"\"+(t.src??s.src))") # hacky but in certain conditions react will try to reset the source on something after it loads to re-trigger the load event but this breaks jsnetproxy.  This allows the same triggering but uses the existing source if it exists.  https://github.com/facebook/react/blob/37906d4dfbe80d71f312f7347bb9ddb930484d28/packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js#L744

we could check it after load but thats a bit of a pita can't seem to override the src attribute to make it read only or anything.  we could copy it but if it needs the handle to it that would break it.
*/