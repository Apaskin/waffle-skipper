// page-extractor.js — Runs in the MAIN world (page context)
// Has access to YouTube's JS variables AND the page's cookies/session.
// Extracts caption tracks AND fetches the transcript JSON directly,
// then sends the full transcript data to the content script via postMessage.
//
// This avoids the problem where the background service worker can't fetch
// YouTube's caption URLs (they contain session-bound auth tokens).

(function () {
  'use strict';

  console.log('[Waffle Skipper Extractor] MAIN world script loaded');

  // ============================================================
  // Caption Track Extraction
  // ============================================================

  function findCaptionTracks() {
    var captionTracks = null;

    // Method 1: movie_player.getPlayerResponse() — best for SPA navigations
    try {
      var player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        var resp = player.getPlayerResponse();
        if (resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer) {
          captionTracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks;
          if (captionTracks && captionTracks.length > 0) {
            console.log('[Waffle Skipper Extractor] Found', captionTracks.length, 'tracks via getPlayerResponse');
            return captionTracks;
          }
        }
      }
    } catch (e) {}

    // Method 2: ytInitialPlayerResponse global — works on initial page load
    try {
      if (window.ytInitialPlayerResponse &&
          window.ytInitialPlayerResponse.captions &&
          window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer) {
        captionTracks = window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (captionTracks && captionTracks.length > 0) {
          console.log('[Waffle Skipper Extractor] Found', captionTracks.length, 'tracks via ytInitialPlayerResponse');
          return captionTracks;
        }
      }
    } catch (e) {}

    // Method 3: Scan script tags for embedded caption data
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent;
        if (text && text.length > 100 && text.indexOf('"captionTracks"') !== -1) {
          var idx = text.indexOf('"captionTracks":');
          var bracketStart = text.indexOf('[', idx);
          if (bracketStart !== -1 && bracketStart - idx < 20) {
            var depth = 0, bracketEnd = bracketStart;
            for (var j = bracketStart; j < text.length && j < bracketStart + 10000; j++) {
              if (text[j] === '[') depth++;
              if (text[j] === ']') { depth--; if (depth === 0) { bracketEnd = j + 1; break; } }
            }
            if (bracketEnd > bracketStart) {
              captionTracks = JSON.parse(text.substring(bracketStart, bracketEnd));
              if (captionTracks && captionTracks.length > 0) {
                console.log('[Waffle Skipper Extractor] Found', captionTracks.length, 'tracks via HTML parsing');
                return captionTracks;
              }
            }
          }
        }
      }
    } catch (e) {}

    return null;
  }

  // Pick the best caption track (prefer English)
  function pickBestTrack(tracks) {
    return tracks.find(function(t) { return t.languageCode === 'en'; })
      || tracks.find(function(t) { return t.languageCode && t.languageCode.indexOf('en') === 0; })
      || tracks[0];
  }

  // ============================================================
  // Transcript Fetching (from MAIN world = has YouTube cookies)
  // ============================================================

  // Fetch the transcript from the MAIN world.
  // Using XMLHttpRequest because it sends cookies with the request,
  // which is required for YouTube's session-bound caption URLs.
  //
  // YouTube's timedtext API can return JSON (fmt=json3) or XML (default).
  // We try JSON first, then fall back to parsing XML if needed.
  function fetchTranscriptJSON(captionUrl, callback) {
    // Try JSON format first
    var jsonUrl = captionUrl;
    // Remove any existing fmt parameter and add fmt=json3
    if (jsonUrl.indexOf('&fmt=') !== -1) {
      jsonUrl = jsonUrl.replace(/&fmt=[^&]*/, '&fmt=json3');
    } else {
      jsonUrl = jsonUrl + '&fmt=json3';
    }

    console.log('[Waffle Skipper Extractor] Trying JSON format...');
    fetchUrl(jsonUrl, function (responseText) {
      if (responseText) {
        // Try parsing as JSON
        try {
          var data = JSON.parse(responseText);
          if (data.events && data.events.length > 0) {
            console.log('[Waffle Skipper Extractor] Got JSON transcript:', data.events.length, 'events');
            callback(data);
            return;
          }
        } catch (e) {
          console.log('[Waffle Skipper Extractor] JSON parse failed, response starts with:', responseText.substring(0, 100));
        }
      }

      // JSON didn't work — try XML format (YouTube's default)
      console.log('[Waffle Skipper Extractor] Trying XML format...');
      var xmlUrl = captionUrl;
      // Remove fmt parameter to get default XML
      if (xmlUrl.indexOf('&fmt=') !== -1) {
        xmlUrl = xmlUrl.replace(/&fmt=[^&]*/, '');
      }

      fetchUrl(xmlUrl, function (xmlText) {
        if (xmlText && xmlText.indexOf('<') === 0) {
          var parsed = parseXmlTranscript(xmlText);
          if (parsed && parsed.events.length > 0) {
            console.log('[Waffle Skipper Extractor] Got XML transcript:', parsed.events.length, 'events');
            callback(parsed);
            return;
          }
        }

        // Last resort: try srv3 format
        console.log('[Waffle Skipper Extractor] Trying srv3 format...');
        var srv3Url = captionUrl;
        if (srv3Url.indexOf('&fmt=') !== -1) {
          srv3Url = srv3Url.replace(/&fmt=[^&]*/, '&fmt=srv3');
        } else {
          srv3Url = srv3Url + '&fmt=srv3';
        }

        fetchUrl(srv3Url, function (srv3Text) {
          if (srv3Text && srv3Text.indexOf('<') === 0) {
            var srv3Parsed = parseXmlTranscript(srv3Text);
            if (srv3Parsed && srv3Parsed.events.length > 0) {
              console.log('[Waffle Skipper Extractor] Got srv3 transcript:', srv3Parsed.events.length, 'events');
              callback(srv3Parsed);
              return;
            }
          }
          console.warn('[Waffle Skipper Extractor] All transcript formats failed');
          callback(null);
        });
      });
    });
  }

  // Simple XHR fetch helper
  function fetchUrl(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (xhr.status === 200 && xhr.responseText && xhr.responseText.length > 10) {
        callback(xhr.responseText);
      } else {
        console.log('[Waffle Skipper Extractor] Fetch status:', xhr.status, 'length:', (xhr.responseText || '').length);
        callback(null);
      }
    };
    xhr.onerror = function () {
      console.warn('[Waffle Skipper Extractor] XHR network error');
      callback(null);
    };
    xhr.send();
  }

  // Parse YouTube's XML transcript format into our standard format
  // YouTube XML format: <transcript><text start="0" dur="5.2">caption text</text>...</transcript>
  function parseXmlTranscript(xmlText) {
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xmlText, 'text/xml');
      var textNodes = doc.querySelectorAll('text');

      if (textNodes.length === 0) {
        // Try body > p format (srv3)
        textNodes = doc.querySelectorAll('body p, p');
      }

      if (textNodes.length === 0) return null;

      var events = [];
      for (var i = 0; i < textNodes.length; i++) {
        var node = textNodes[i];
        var start = parseFloat(node.getAttribute('start') || node.getAttribute('t') || '0');
        var dur = parseFloat(node.getAttribute('dur') || node.getAttribute('d') || '0');
        var text = node.textContent || '';

        // Convert to JSON3-like format that our chunker expects
        events.push({
          tStartMs: Math.round(start * 1000),
          dDurationMs: Math.round(dur * 1000),
          segs: [{ utf8: decodeHtmlEntities(text) }]
        });
      }

      return { events: events };
    } catch (e) {
      console.warn('[Waffle Skipper Extractor] XML parse error:', e.message);
      return null;
    }
  }

  // Decode HTML entities in caption text (e.g., &amp; &#39;)
  function decodeHtmlEntities(text) {
    var el = document.createElement('textarea');
    el.innerHTML = text;
    return el.value;
  }

  // ============================================================
  // Main Extraction + Fetch Pipeline
  // ============================================================

  function extractAndPost() {
    var captionTracks = findCaptionTracks();

    if (!captionTracks || captionTracks.length === 0) {
      console.log('[Waffle Skipper Extractor] No caption tracks found');
      window.postMessage({
        source: 'waffle-skipper-extractor',
        tracks: [],
        transcript: null,
        error: 'No caption tracks found'
      }, '*');
      return;
    }

    var bestTrack = pickBestTrack(captionTracks);
    var trackInfo = {
      baseUrl: bestTrack.baseUrl,
      lang: bestTrack.languageCode,
      name: (bestTrack.name && bestTrack.name.simpleText) || bestTrack.languageCode
    };
    console.log('[Waffle Skipper Extractor] Best track:', trackInfo.lang, trackInfo.name);

    // Fetch the actual transcript JSON from the MAIN world (has cookies)
    fetchTranscriptJSON(bestTrack.baseUrl, function (transcriptData) {
      window.postMessage({
        source: 'waffle-skipper-extractor',
        tracks: [trackInfo],
        transcript: transcriptData // Full JSON3 transcript data, or null if fetch failed
      }, '*');
    });
  }

  // ============================================================
  // Event Listeners
  // ============================================================

  // Initial extraction after page loads
  setTimeout(extractAndPost, 1000);

  // Re-extract on YouTube SPA navigations
  document.addEventListener('yt-navigate-finish', function () {
    console.log('[Waffle Skipper Extractor] yt-navigate-finish, re-extracting...');
    setTimeout(extractAndPost, 2000);
  });

  // Listen for explicit requests from the content script
  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'waffle-skipper-request') {
      extractAndPost();
    }
  });
})();
