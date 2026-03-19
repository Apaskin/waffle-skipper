// page-extractor.js — Runs in the MAIN world at document_start
//
// APPROACH: Intercept YouTube's own caption/timedtext network requests.
// YouTube fetches captions for its player automatically — we just capture
// that response instead of making our own API calls (which all fail due
// to YouTube's auth requirements).
//
// This script patches XMLHttpRequest BEFORE YouTube's scripts load
// (run_at: document_start), so we catch every timedtext request.

(function () {
  'use strict';

  // Store captured transcript data, keyed by video ID
  var capturedTranscripts = {};

  // ============================================================
  // XMLHttpRequest Interception
  // ============================================================

  // Patch XMLHttpRequest to intercept YouTube's timedtext requests.
  // YouTube's player uses XHR to fetch captions. We wrap the original
  // open/send to detect timedtext URLs and capture the response.

  var OriginalXHR = window.XMLHttpRequest;
  var originalOpen = OriginalXHR.prototype.open;
  var originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (method, url) {
    // Check if this is a timedtext/caption request
    if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1 && url.indexOf('fmt=json3') !== -1) {
      this._waffleTimedtextUrl = url;
    }
    return originalOpen.apply(this, arguments);
  };

  OriginalXHR.prototype.send = function () {
    if (this._waffleTimedtextUrl) {
      var url = this._waffleTimedtextUrl;
      var xhr = this;

      var originalOnReadyStateChange = xhr.onreadystatechange;
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && xhr.status === 200 && xhr.responseText) {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data.events && data.events.length > 0) {
              // Extract video ID from the URL
              var videoId = extractVideoIdFromUrl(url);
              if (videoId) {
                console.log('[Waffle Skipper Extractor] Captured timedtext response for', videoId, ':', data.events.length, 'events');
                capturedTranscripts[videoId] = data;
                // Post immediately in case content script is already waiting
                window.postMessage({
                  source: 'waffle-skipper-extractor',
                  transcript: data,
                  tracks: [],
                  videoId: videoId,
                  method: 'xhr-intercept'
                }, '*');
              }
            }
          } catch (e) {
            // Not JSON or not a caption response — ignore
          }
        }
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      };

      // Also handle addEventListener('load', ...) pattern
      xhr.addEventListener('load', function () {
        if (xhr.status === 200 && xhr.responseText) {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data.events && data.events.length > 0) {
              var videoId = extractVideoIdFromUrl(url);
              if (videoId && !capturedTranscripts[videoId]) {
                console.log('[Waffle Skipper Extractor] Captured timedtext (load event) for', videoId, ':', data.events.length, 'events');
                capturedTranscripts[videoId] = data;
                window.postMessage({
                  source: 'waffle-skipper-extractor',
                  transcript: data,
                  tracks: [],
                  videoId: videoId,
                  method: 'xhr-intercept-load'
                }, '*');
              }
            }
          } catch (e) {}
        }
      });
    }

    return originalSend.apply(this, arguments);
  };

  // ============================================================
  // Fetch Interception
  // ============================================================

  // YouTube might also use fetch() for captions in some cases.
  // Patch window.fetch to intercept timedtext requests.

  var originalFetch = window.fetch;
  window.fetch = function () {
    var url = arguments[0];
    if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1 && url.indexOf('fmt=json3') !== -1) {
      var captureUrl = url;
      return originalFetch.apply(this, arguments).then(function (response) {
        // Clone the response so we can read it without consuming it
        var clone = response.clone();
        clone.text().then(function (text) {
          try {
            var data = JSON.parse(text);
            if (data.events && data.events.length > 0) {
              var videoId = extractVideoIdFromUrl(captureUrl);
              if (videoId && !capturedTranscripts[videoId]) {
                console.log('[Waffle Skipper Extractor] Captured timedtext (fetch) for', videoId, ':', data.events.length, 'events');
                capturedTranscripts[videoId] = data;
                window.postMessage({
                  source: 'waffle-skipper-extractor',
                  transcript: data,
                  tracks: [],
                  videoId: videoId,
                  method: 'fetch-intercept'
                }, '*');
              }
            }
          } catch (e) {}
        });
        return response;
      });
    }
    return originalFetch.apply(this, arguments);
  };

  // ============================================================
  // Utility
  // ============================================================

  function extractVideoIdFromUrl(url) {
    try {
      var match = url.match(/[?&]v=([^&]+)/);
      return match ? match[1] : null;
    } catch (e) {
      return null;
    }
  }

  // ============================================================
  // Content Script Communication
  // ============================================================

  // Listen for requests from the content script asking for transcript data
  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'waffle-skipper-request') {
      var requestedVideoId = event.data.videoId;
      console.log('[Waffle Skipper Extractor] Content script requested data for:', requestedVideoId);

      if (requestedVideoId && capturedTranscripts[requestedVideoId]) {
        // We already have the transcript — send it immediately
        console.log('[Waffle Skipper Extractor] Sending cached transcript for', requestedVideoId);
        window.postMessage({
          source: 'waffle-skipper-extractor',
          transcript: capturedTranscripts[requestedVideoId],
          tracks: [],
          videoId: requestedVideoId,
          method: 'cache'
        }, '*');
      } else {
        // We don't have it yet — YouTube might not have loaded captions yet.
        // Send empty response; content script will retry.
        console.log('[Waffle Skipper Extractor] No transcript cached yet for', requestedVideoId);
        window.postMessage({
          source: 'waffle-skipper-extractor',
          transcript: null,
          tracks: [],
          videoId: requestedVideoId,
          error: 'Transcript not captured yet — YouTube may not have loaded captions'
        }, '*');
      }
    }
  });

  console.log('[Waffle Skipper Extractor] XHR/fetch interception active, waiting for YouTube to load captions...');
})();
