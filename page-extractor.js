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

  // Fetch the transcript JSON directly from the MAIN world.
  // Using XMLHttpRequest because it sends cookies with the request,
  // which is required for YouTube's session-bound caption URLs.
  function fetchTranscriptJSON(captionUrl, callback) {
    var url = captionUrl.indexOf('fmt=json3') !== -1 ? captionUrl : captionUrl + '&fmt=json3';
    console.log('[Waffle Skipper Extractor] Fetching transcript from:', url.substring(0, 80) + '...');

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.events && data.events.length > 0) {
            console.log('[Waffle Skipper Extractor] Got transcript:', data.events.length, 'events');
            callback(data);
            return;
          }
        } catch (e) {
          console.warn('[Waffle Skipper Extractor] Failed to parse transcript JSON:', e.message);
        }
      } else {
        console.warn('[Waffle Skipper Extractor] Transcript fetch HTTP error:', xhr.status);
      }
      callback(null);
    };
    xhr.onerror = function () {
      console.warn('[Waffle Skipper Extractor] Transcript fetch network error');
      callback(null);
    };
    xhr.send();
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
