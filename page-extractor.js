// page-extractor.js — Runs in the MAIN world (page context)
// This script has access to YouTube's JS variables like ytInitialPlayerResponse
// and the movie_player API. It extracts caption track URLs and sends them
// to the content script (ISOLATED world) via window.postMessage.
//
// Loaded via manifest.json with "world": "MAIN" to bypass YouTube's CSP.

(function () {
  'use strict';

  console.log('[Waffle Skipper Extractor] MAIN world script loaded');

  // Extract caption tracks from YouTube's player data and post them
  function extractAndPostCaptions() {
    console.log('[Waffle Skipper Extractor] Extracting caption tracks...');
    var captionTracks = null;
    var methodUsed = 'none';

    // Method 1: movie_player.getPlayerResponse()
    // Best for SPA navigations where ytInitialPlayerResponse is stale
    try {
      var player = document.getElementById('movie_player');
      console.log('[Waffle Skipper Extractor] movie_player found:', !!player);
      if (player) {
        console.log('[Waffle Skipper Extractor] getPlayerResponse exists:', typeof player.getPlayerResponse);
        if (typeof player.getPlayerResponse === 'function') {
          var resp = player.getPlayerResponse();
          console.log('[Waffle Skipper Extractor] getPlayerResponse returned:', !!resp);
          if (resp) {
            console.log('[Waffle Skipper Extractor] resp.captions exists:', !!resp.captions);
            if (resp.captions && resp.captions.playerCaptionsTracklistRenderer) {
              captionTracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks;
              methodUsed = 'getPlayerResponse';
              console.log('[Waffle Skipper Extractor] Method 1 found tracks:', captionTracks ? captionTracks.length : 0);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Waffle Skipper Extractor] Method 1 error:', e.message);
    }

    // Method 2: ytInitialPlayerResponse global
    // Works on initial page load (not SPA nav)
    if (!captionTracks || captionTracks.length === 0) {
      try {
        console.log('[Waffle Skipper Extractor] ytInitialPlayerResponse exists:', typeof window.ytInitialPlayerResponse !== 'undefined');
        if (window.ytInitialPlayerResponse) {
          console.log('[Waffle Skipper Extractor] ytIPR.captions exists:', !!(window.ytInitialPlayerResponse.captions));
          if (window.ytInitialPlayerResponse.captions &&
              window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer) {
            captionTracks = window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
            methodUsed = 'ytInitialPlayerResponse';
            console.log('[Waffle Skipper Extractor] Method 2 found tracks:', captionTracks ? captionTracks.length : 0);
          }
        }
      } catch (e) {
        console.warn('[Waffle Skipper Extractor] Method 2 error:', e.message);
      }
    }

    // Method 3: ytplayer.config.args.raw_player_response
    // Another location YouTube sometimes stores player data
    if (!captionTracks || captionTracks.length === 0) {
      try {
        if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
          var rawResp = window.ytplayer.config.args.raw_player_response;
          if (rawResp && rawResp.captions && rawResp.captions.playerCaptionsTracklistRenderer) {
            captionTracks = rawResp.captions.playerCaptionsTracklistRenderer.captionTracks;
            methodUsed = 'ytplayer.config';
            console.log('[Waffle Skipper Extractor] Method 3 found tracks:', captionTracks ? captionTracks.length : 0);
          }
        }
      } catch (e) {
        console.warn('[Waffle Skipper Extractor] Method 3 error:', e.message);
      }
    }

    // Method 4: Scan page HTML for captionTracks data
    // Last resort — works even if JS variables have been garbage collected
    if (!captionTracks || captionTracks.length === 0) {
      try {
        var scripts = document.getElementsByTagName('script');
        for (var i = 0; i < scripts.length; i++) {
          var text = scripts[i].textContent;
          if (text && text.length > 100 && text.indexOf('"captionTracks"') !== -1) {
            // Find the captionTracks array in the script content
            var captionIdx = text.indexOf('"captionTracks":');
            if (captionIdx !== -1) {
              var bracketStart = text.indexOf('[', captionIdx);
              if (bracketStart !== -1 && bracketStart - captionIdx < 20) {
                // Find matching closing bracket by tracking depth
                var depth = 0;
                var bracketEnd = bracketStart;
                for (var j = bracketStart; j < text.length && j < bracketStart + 10000; j++) {
                  if (text[j] === '[') depth++;
                  if (text[j] === ']') {
                    depth--;
                    if (depth === 0) { bracketEnd = j + 1; break; }
                  }
                }
                if (bracketEnd > bracketStart) {
                  captionTracks = JSON.parse(text.substring(bracketStart, bracketEnd));
                  methodUsed = 'HTML parsing';
                  console.log('[Waffle Skipper Extractor] Method 4 found tracks:', captionTracks ? captionTracks.length : 0);
                  break;
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[Waffle Skipper Extractor] Method 4 error:', e.message);
      }
    }

    // Build and send the result
    var message = { source: 'waffle-skipper-extractor' };

    if (captionTracks && captionTracks.length > 0) {
      message.tracks = [];
      for (var k = 0; k < captionTracks.length; k++) {
        var t = captionTracks[k];
        message.tracks.push({
          baseUrl: t.baseUrl,
          lang: t.languageCode,
          name: (t.name && t.name.simpleText) || t.languageCode,
          kind: t.kind || ''
        });
      }
      message.method = methodUsed;
      console.log('[Waffle Skipper Extractor] Posting', message.tracks.length, 'tracks via', methodUsed);
    } else {
      message.tracks = [];
      message.error = 'No caption tracks found via any method';
      console.warn('[Waffle Skipper Extractor] No tracks found by any method');
    }

    window.postMessage(message, '*');
  }

  // Run extraction on initial load
  // Use a small delay to ensure YouTube's player is initialized
  setTimeout(extractAndPostCaptions, 500);

  // Re-extract on YouTube SPA navigations
  document.addEventListener('yt-navigate-finish', function () {
    console.log('[Waffle Skipper Extractor] yt-navigate-finish detected, re-extracting...');
    // Longer delay on SPA nav to let the player fully initialize
    setTimeout(extractAndPostCaptions, 1500);
  });

  // Listen for explicit requests from the content script
  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'waffle-skipper-request') {
      console.log('[Waffle Skipper Extractor] Received request from content script');
      extractAndPostCaptions();
    }
  });
})();
