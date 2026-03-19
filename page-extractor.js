// page-extractor.js — Runs in the MAIN world (page context)
// Has full access to YouTube's JS context, cookies, and session.
//
// Uses YouTube's own innertube get_transcript API — the same API that
// YouTube's "Show transcript" button calls. This is the most reliable
// method because it works with auto-generated captions and doesn't
// require the timedtext URL (which returns empty from XHR/fetch).
//
// Loaded via manifest.json with "world": "MAIN".

(function () {
  'use strict';

  console.log('[Waffle Skipper Extractor] MAIN world script loaded');

  // ============================================================
  // Innertube Transcript API
  // ============================================================

  // Get transcript using YouTube's innertube get_transcript endpoint.
  // This is the same API YouTube calls when you click "Show transcript".
  // It works reliably because we're in the MAIN world with full auth context.
  function fetchTranscriptViaInnertube(videoId, callback) {
    console.log('[Waffle Skipper Extractor] Fetching transcript via innertube for:', videoId);

    // Step 1: Get the transcript params from the page data.
    // These params tell the API which video and language to get.
    var params = findTranscriptParams();
    if (!params) {
      // Build params manually if not found in page
      params = buildTranscriptParams(videoId);
    }

    if (!params) {
      console.warn('[Waffle Skipper Extractor] Could not find or build transcript params');
      callback(null);
      return;
    }

    // Step 2: Get the innertube API key and context from ytcfg
    var apiKey = null;
    var context = null;

    try {
      if (typeof window.ytcfg !== 'undefined' && typeof window.ytcfg.get === 'function') {
        apiKey = window.ytcfg.get('INNERTUBE_API_KEY');
        context = window.ytcfg.get('INNERTUBE_CONTEXT');
      }
    } catch (e) {}

    // Fallback: extract from page HTML if ytcfg not available
    if (!apiKey) {
      try {
        var scripts = document.getElementsByTagName('script');
        for (var i = 0; i < scripts.length; i++) {
          var text = scripts[i].textContent;
          if (text && text.indexOf('INNERTUBE_API_KEY') !== -1) {
            var keyMatch = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
            if (keyMatch) { apiKey = keyMatch[1]; break; }
          }
        }
      } catch (e) {}
    }

    if (!apiKey || !context) {
      console.warn('[Waffle Skipper Extractor] Missing innertube API key or context');
      callback(null);
      return;
    }

    console.log('[Waffle Skipper Extractor] Calling get_transcript API...');

    // Step 3: Call the innertube get_transcript API
    // Using fetch() from the MAIN world automatically includes YouTube's
    // session cookies, SAPISID auth, and all other auth context.
    fetch('/youtubei/v1/get_transcript?key=' + apiKey + '&prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: context,
        params: params
      })
    })
    .then(function (response) {
      if (!response.ok) {
        console.warn('[Waffle Skipper Extractor] get_transcript HTTP error:', response.status);
        return null;
      }
      return response.json();
    })
    .then(function (json) {
      if (!json) { callback(null); return; }

      // Parse the transcript response
      var segments = extractSegmentsFromResponse(json);
      if (segments && segments.length > 0) {
        console.log('[Waffle Skipper Extractor] Got', segments.length, 'transcript segments via innertube');

        // Convert to our JSON3-like event format for the chunker
        var events = segments.map(function (seg) {
          return {
            tStartMs: parseInt(seg.startMs, 10) || 0,
            dDurationMs: (parseInt(seg.endMs, 10) || 0) - (parseInt(seg.startMs, 10) || 0),
            segs: [{ utf8: seg.text }]
          };
        });

        callback({ events: events });
      } else {
        console.warn('[Waffle Skipper Extractor] No segments in get_transcript response');
        callback(null);
      }
    })
    .catch(function (err) {
      console.warn('[Waffle Skipper Extractor] get_transcript fetch error:', err.message);
      callback(null);
    });
  }

  // Find the getTranscriptEndpoint params from the page's player response
  function findTranscriptParams() {
    // Method 1: From getPlayerResponse() (works on SPA navigation)
    try {
      var player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        var resp = player.getPlayerResponse();
        var panels = resp && resp.engagementPanels;
        if (panels) {
          for (var i = 0; i < panels.length; i++) {
            var panelId = panels[i].engagementPanelSectionListRenderer?.panelIdentifier;
            if (panelId === 'engagement-panel-searchable-transcript') {
              var endpoint = panels[i].engagementPanelSectionListRenderer
                ?.header?.engagementPanelTitleHeaderRenderer
                ?.menu?.sortFilterSubMenuRenderer?.subMenuItems;
              // The params are in the continuation
              var content = panels[i].engagementPanelSectionListRenderer?.content;
              var contRenderer = content?.continuationItemRenderer;
              if (contRenderer) {
                var contEndpoint = contRenderer.continuationEndpoint?.getTranscriptEndpoint;
                if (contEndpoint && contEndpoint.params) {
                  console.log('[Waffle Skipper Extractor] Found transcript params via player API');
                  return contEndpoint.params;
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.log('[Waffle Skipper Extractor] Player API params search error:', e.message);
    }

    // Method 2: From ytInitialPlayerResponse
    try {
      if (window.ytInitialPlayerResponse) {
        var panels2 = window.ytInitialPlayerResponse.engagementPanels;
        // Same search as above but in the global
        // Actually, engagementPanels is usually in ytInitialData, not ytInitialPlayerResponse
      }
    } catch (e) {}

    // Method 3: From ytInitialData
    try {
      if (window.ytInitialData) {
        var panels3 = window.ytInitialData.engagementPanels;
        if (panels3) {
          for (var j = 0; j < panels3.length; j++) {
            var panelId3 = panels3[j].engagementPanelSectionListRenderer?.panelIdentifier;
            if (panelId3 === 'engagement-panel-searchable-transcript') {
              var content3 = panels3[j].engagementPanelSectionListRenderer?.content;
              var contRenderer3 = content3?.continuationItemRenderer;
              if (contRenderer3) {
                var endpoint3 = contRenderer3.continuationEndpoint?.getTranscriptEndpoint;
                if (endpoint3 && endpoint3.params) {
                  console.log('[Waffle Skipper Extractor] Found transcript params via ytInitialData');
                  return endpoint3.params;
                }
              }
            }
          }
        }
      }
    } catch (e) {}

    // Method 4: Scan page HTML for getTranscriptEndpoint
    try {
      var pageHtml = document.documentElement.innerHTML;
      var idx = pageHtml.indexOf('"getTranscriptEndpoint"');
      if (idx !== -1) {
        var paramMatch = pageHtml.substring(idx, idx + 200).match(/"params":"([^"]+)"/);
        if (paramMatch) {
          console.log('[Waffle Skipper Extractor] Found transcript params via HTML scan');
          return paramMatch[1];
        }
      }
    } catch (e) {}

    console.log('[Waffle Skipper Extractor] No transcript params found in page');
    return null;
  }

  // Build transcript params manually from video ID
  // This is a protobuf-encoded message with the video ID
  function buildTranscriptParams(videoId) {
    try {
      // Protobuf encoding: field 1 (string) = video ID
      var videoIdBytes = [];
      for (var i = 0; i < videoId.length; i++) {
        videoIdBytes.push(videoId.charCodeAt(i));
      }

      // Tag for field 1, wire type 2 (length-delimited): (1 << 3) | 2 = 0x0a
      var field1 = [0x0a, videoIdBytes.length].concat(videoIdBytes);

      // Encode as base64
      var binary = String.fromCharCode.apply(null, field1);
      return btoa(binary);
    } catch (e) {
      return null;
    }
  }

  // Extract transcript segments from the innertube get_transcript response
  function extractSegmentsFromResponse(json) {
    try {
      var actions = json.actions || [];
      for (var i = 0; i < actions.length; i++) {
        var action = actions[i];
        var panelContent = action.updateEngagementPanelAction
          && action.updateEngagementPanelAction.content
          && action.updateEngagementPanelAction.content.transcriptRenderer
          && action.updateEngagementPanelAction.content.transcriptRenderer.content;

        if (!panelContent) continue;

        var searchPanel = panelContent.transcriptSearchPanelRenderer;
        if (!searchPanel) continue;

        var segList = searchPanel.body
          && searchPanel.body.transcriptSegmentListRenderer;
        if (!segList) continue;

        var rawSegments = segList.initialSegments || [];
        var segments = [];

        for (var j = 0; j < rawSegments.length; j++) {
          var seg = rawSegments[j].transcriptSegmentRenderer;
          if (seg) {
            var text = '';
            var runs = seg.snippet && seg.snippet.runs;
            if (runs) {
              for (var k = 0; k < runs.length; k++) {
                text += runs[k].text || '';
              }
            }
            segments.push({
              startMs: seg.startMs || '0',
              endMs: seg.endMs || '0',
              text: text
            });
          }
        }

        return segments;
      }
    } catch (e) {
      console.warn('[Waffle Skipper Extractor] Error parsing transcript response:', e.message);
    }
    return null;
  }

  // ============================================================
  // Caption Track Extraction (for info display, not transcript fetching)
  // ============================================================

  function findCaptionInfo() {
    try {
      var player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        var resp = player.getPlayerResponse();
        if (resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer) {
          var tracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks;
          if (tracks && tracks.length > 0) {
            return tracks.map(function (t) {
              return {
                lang: t.languageCode,
                name: (t.name && t.name.simpleText) || t.languageCode,
                kind: t.kind || ''
              };
            });
          }
        }
      }
    } catch (e) {}
    return [];
  }

  // ============================================================
  // Main Pipeline
  // ============================================================

  function extractAndPost() {
    // Get the video ID from the URL
    var urlParams = new URLSearchParams(window.location.search);
    var videoId = urlParams.get('v');

    if (!videoId) {
      console.log('[Waffle Skipper Extractor] Not on a watch page');
      window.postMessage({
        source: 'waffle-skipper-extractor',
        tracks: [],
        transcript: null,
        error: 'Not on a watch page'
      }, '*');
      return;
    }

    var trackInfo = findCaptionInfo();
    console.log('[Waffle Skipper Extractor] Caption info:', trackInfo.length, 'tracks');

    // Fetch transcript via innertube API
    fetchTranscriptViaInnertube(videoId, function (transcriptData) {
      window.postMessage({
        source: 'waffle-skipper-extractor',
        tracks: trackInfo,
        transcript: transcriptData
      }, '*');
    });
  }

  // ============================================================
  // Event Listeners
  // ============================================================

  // Initial extraction after page loads
  setTimeout(extractAndPost, 1500);

  // Re-extract on YouTube SPA navigations
  document.addEventListener('yt-navigate-finish', function () {
    console.log('[Waffle Skipper Extractor] yt-navigate-finish, re-extracting...');
    setTimeout(extractAndPost, 2500);
  });

  // Listen for explicit requests from the content script
  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'waffle-skipper-request') {
      extractAndPost();
    }
  });
})();
