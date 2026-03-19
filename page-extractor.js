// page-extractor.js — Runs in the MAIN world at document_start
//
// Intercepts YouTube's own XHR/fetch caption requests to capture transcript data.
// YouTube's player fetches captions via /api/timedtext — we patch XMLHttpRequest
// and fetch BEFORE YouTube's scripts load to capture those responses.
//
// This is the only reliable approach because YouTube's caption URLs require
// browser-level session context that can't be replicated from extension code.

(function () {
  'use strict';

  // Store captured transcript data, keyed by video ID
  var capturedTranscripts = {};

  // ============================================================
  // XMLHttpRequest Interception
  // ============================================================

  var OrigXHR = window.XMLHttpRequest;
  var origOpen = OrigXHR.prototype.open;
  var origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url) {
    // Flag timedtext requests so we can capture the response
    if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1) {
      this._waffleTimedtextUrl = url;
    }
    return origOpen.apply(this, arguments);
  };

  OrigXHR.prototype.send = function () {
    var xhr = this;
    var url = this._waffleTimedtextUrl;

    if (url) {
      xhr.addEventListener('load', function () {
        if (xhr.status === 200 && xhr.responseText && xhr.responseText.length > 100) {
          handleTimedtextResponse(url, xhr.responseText);
        }
      });
    }

    return origSend.apply(this, arguments);
  };

  // ============================================================
  // Fetch Interception
  // ============================================================

  var origFetch = window.fetch;
  window.fetch = function () {
    var url = (arguments[0] && typeof arguments[0] === 'string') ? arguments[0]
      : (arguments[0] && arguments[0].url) ? arguments[0].url : '';

    if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1) {
      var captureUrl = url;
      return origFetch.apply(this, arguments).then(function (response) {
        var clone = response.clone();
        clone.text().then(function (text) {
          if (response.ok && text.length > 100) {
            handleTimedtextResponse(captureUrl, text);
          }
        });
        return response;
      });
    }
    return origFetch.apply(this, arguments);
  };

  // ============================================================
  // Response Handling
  // ============================================================

  function handleTimedtextResponse(url, responseText) {
    var videoId = extractVideoIdFromUrl(url);
    if (!videoId) return;

    // Already captured this video — skip
    if (capturedTranscripts[videoId]) return;

    // Try JSON parse (json3 format)
    try {
      var data = JSON.parse(responseText);
      if (data.events && data.events.length > 0) {
        console.log('[Waffle Skipper Extractor] Captured transcript for', videoId + ':', data.events.length, 'events');
        capturedTranscripts[videoId] = data;
        postTranscript(videoId, data, 'json');
        return;
      }
    } catch (e) {}

    // Try XML parse (default/srv3 format)
    try {
      if (responseText.trim().charAt(0) === '<') {
        var parsed = parseXmlTranscript(responseText);
        if (parsed && parsed.events.length > 0) {
          console.log('[Waffle Skipper Extractor] Captured XML transcript for', videoId + ':', parsed.events.length, 'events');
          capturedTranscripts[videoId] = parsed;
          postTranscript(videoId, parsed, 'xml');
          return;
        }
      }
    } catch (e) {}
  }

  function extractVideoIdFromUrl(url) {
    try {
      var match = url.match(/[?&]v=([^&]+)/);
      return match ? match[1] : null;
    } catch (e) {
      return null;
    }
  }

  function postTranscript(videoId, data, method) {
    window.postMessage({
      source: 'waffle-skipper-extractor',
      transcript: data,
      tracks: [],
      videoId: videoId,
      method: method
    }, '*');
  }

  function parseXmlTranscript(xmlText) {
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xmlText, 'text/xml');
      var textNodes = doc.querySelectorAll('text');
      if (textNodes.length === 0) textNodes = doc.querySelectorAll('p');
      if (textNodes.length === 0) return null;

      var events = [];
      for (var i = 0; i < textNodes.length; i++) {
        var node = textNodes[i];
        var start = parseFloat(node.getAttribute('start') || node.getAttribute('t') || '0');
        var dur = parseFloat(node.getAttribute('dur') || node.getAttribute('d') || '0');
        events.push({
          tStartMs: Math.round(start * 1000),
          dDurationMs: Math.round(dur * 1000),
          segs: [{ utf8: node.textContent || '' }]
        });
      }
      return { events: events };
    } catch (e) { return null; }
  }

  // ============================================================
  // Content Script Communication
  // ============================================================

  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'waffle-skipper-request') {
      var vid = event.data.videoId;
      if (vid && capturedTranscripts[vid]) {
        postTranscript(vid, capturedTranscripts[vid], 'cache');
      } else {
        window.postMessage({
          source: 'waffle-skipper-extractor',
          transcript: null,
          tracks: [],
          videoId: vid,
          error: 'Not captured yet'
        }, '*');
      }
    }
  });

  console.log('[Waffle Skipper Extractor] Listening for YouTube caption requests...');
})();
