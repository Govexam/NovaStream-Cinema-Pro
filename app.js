/**
 * NOVASTREAM CINEMA PRO - APPLICATION ENGINE
 * Features:
 * - Dynamic 24-Hour EPG Schedule & Timeline Engine
 * - HLS.js Live Video Stream Playback & Recovery
 * - Custom Cinema Controls (PiP, Aspect Ratio, 200% Audio Boost)
 * - Channel Zapping & Keyboard Navigation
 * - Real-Time Search & Category Filters
 */

(function () {
  'use strict';

  // --- STATE ---
  let allChannels = [];
  let displayedChannels = [];
  let currentChannel = null;
  let currentChannelIndex = 0;
  let activeCategory = 'ALL';
  let searchQuery = '';
  
  let hls = null;
  let audioCtx = null;
  let gainNode = null;
  let isAudioBoosted = false;
  let streamRetryCount = 0;
  let osdTimer = null;
  let currentAspectRatioIdx = 0;
  const aspectRatios = ['contain', 'cover', 'fill'];

  // --- DOM ELEMENTS ---
  const el = {
    videoPlayer: document.getElementById('videoPlayer'),
    videoSpinner: document.getElementById('videoSpinner'),
    spinnerText: document.getElementById('spinnerText'),
    playerOsd: document.getElementById('playerOsd'),
    osdLogo: document.getElementById('osdLogo'),
    osdChannelName: document.getElementById('osdChannelName'),
    osdCategoryBadge: document.getElementById('osdCategoryBadge'),
    osdQualityBadge: document.getElementById('osdQualityBadge'),
    playBtn: document.getElementById('playBtn'),
    playIcon: document.getElementById('playIcon'),
    pauseIcon: document.getElementById('pauseIcon'),
    volumeSlider: document.getElementById('volumeSlider'),
    audioBoostBtn: document.getElementById('audioBoostBtn'),
    
    // Live EPG Elements
    nowTimeRange: document.getElementById('nowTimeRange'),
    nowShowTitle: document.getElementById('nowShowTitle'),
    nowShowDesc: document.getElementById('nowShowDesc'),
    nowProgressFill: document.getElementById('nowProgressFill'),
    nowStartLabel: document.getElementById('nowStartLabel'),
    nowRemainingLabel: document.getElementById('nowRemainingLabel'),
    nowEndLabel: document.getElementById('nowEndLabel'),
    upcomingGrid: document.getElementById('upcomingGrid'),
    
    // Channel Guide
    channelListScroll: document.getElementById('channelListScroll'),
    channelCountBadge: document.getElementById('channelCountBadge'),
    channelSearchInput: document.getElementById('channelSearchInput'),
    searchClearBtn: document.getElementById('searchClearBtn'),
    categoryPills: document.getElementById('categoryPills'),
    
    // Clock & Modals
    liveClockText: document.getElementById('liveClockText'),
    fullEpgModal: document.getElementById('fullEpgModal'),
    fullEpgModalTitle: document.getElementById('fullEpgModalTitle'),
    fullEpgModalBody: document.getElementById('fullEpgModalBody'),
    vlcGuideModal: document.getElementById('vlcGuideModal'),
    vlcModalStreamUrl: document.getElementById('vlcModalStreamUrl'),
    toastMsg: document.getElementById('toastMsg')
  };

  // ============================================================
  // 1. INITIALIZATION & DATA LOADING
  // ============================================================
  document.addEventListener('DOMContentLoaded', () => {
    initClock();
    initPlayerEvents();
    initKeyboardShortcuts();

    if (window.PREMIUM_CHANNELS && window.PREMIUM_CHANNELS.length > 0) {
      allChannels = window.PREMIUM_CHANNELS;
    } else {
      console.warn("channels.js not loaded, check file path.");
    }

    displayedChannels = allChannels;
    el.channelCountBadge.textContent = `${allChannels.length} Channels`;

    renderChannelList();

    // Start with Channel #1 (Star Sports 1 Hindi) or saved channel
    const savedId = localStorage.getItem('novastream_last_channel_id');
    const startCh = allChannels.find(c => c.id == savedId) || allChannels[0];
    if (startCh) {
      playChannel(startCh);
    }

    // Refresh EPG schedule bars every 30 seconds
    setInterval(() => {
      if (currentChannel) {
        updateCurrentChannelEpg(currentChannel);
      }
      updateChannelListLiveShows();
    }, 30000);
  });

  // ============================================================
  // 2. LIVE CLOCK ENGINE
  // ============================================================
  function initClock() {
    function tick() {
      const now = new Date();
      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      el.liveClockText.textContent = `${String(hours).padStart(2, '0')}:${minutes}:${seconds} ${ampm}`;
    }
    tick();
    setInterval(tick, 1000);
  }

  // ============================================================
  // 3. INTELLIGENT DYNAMIC EPG SCHEDULE ENGINE ("Ye Itna Time Me Aayega")
  // ============================================================
  function parseTimeToMinutes(timeStr) {
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function formatMinutesTo12Hour(minutes) {
    let m = minutes % 1440;
    if (m < 0) m += 1440;
    let h = Math.floor(m / 60);
    const min = String(m % 60).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${String(h).padStart(2, '0')}:${min} ${ampm}`;
  }

  function getChannelEpgData(channel) {
    const schedule = channel.schedule || [];
    if (schedule.length === 0) {
      return {
        currentShow: { title: "Live Satellite Broadcast", desc: "Continuous live television feed.", startStr: "LIVE", endStr: "LIVE", progress: 50, remainingMinutes: 30 },
        upcomingShows: []
      };
    }

    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();

    let currentItem = null;
    let currentIndex = -1;

    for (let i = 0; i < schedule.length; i++) {
      const [startStr, endStr, title, desc] = schedule[i];
      let startM = parseTimeToMinutes(startStr);
      let endM = parseTimeToMinutes(endStr);

      if (endM < startM) {
        // Crosses midnight
        if (currentMins >= startM || currentMins < endM) {
          currentItem = schedule[i];
          currentIndex = i;
          break;
        }
      } else {
        if (currentMins >= startM && currentMins < endM) {
          currentItem = schedule[i];
          currentIndex = i;
          break;
        }
      }
    }

    if (!currentItem) {
      currentItem = schedule[0];
      currentIndex = 0;
    }

    // Calculate progress & remaining time
    const [startStr, endStr, title, desc] = currentItem;
    let startM = parseTimeToMinutes(startStr);
    let endM = parseTimeToMinutes(endStr);
    
    let totalDuration = endM >= startM ? (endM - startM) : (1440 - startM + endM);
    let elapsed = endM >= startM ? (currentMins - startM) : (currentMins >= startM ? currentMins - startM : (1440 - startM + currentMins));
    if (elapsed < 0) elapsed = 0;
    
    let progress = Math.min(100, Math.max(5, Math.round((elapsed / totalDuration) * 100)));
    let remainingMinutes = Math.max(1, totalDuration - elapsed);

    // Compute upcoming shows ("Ye show itna time me aayega")
    const upcomingShows = [];
    for (let step = 1; step <= 4; step++) {
      const nextIdx = (currentIndex + step) % schedule.length;
      const nextItem = schedule[nextIdx];
      const nextStartM = parseTimeToMinutes(nextItem[0]);
      
      let minutesUntil = nextStartM >= currentMins ? (nextStartM - currentMins) : (1440 - currentMins + nextStartM);
      let inHours = Math.floor(minutesUntil / 60);
      let inMins = minutesUntil % 60;
      let startsInText = inHours > 0 ? `In ${inHours}h ${inMins}m` : `In ${inMins} min`;

      upcomingShows.push({
        title: nextItem[2],
        desc: nextItem[3],
        startTimeStr: formatMinutesTo12Hour(nextStartM),
        endTimeStr: formatMinutesTo12Hour(parseTimeToMinutes(nextItem[1])),
        startsInText: startsInText
      });
    }

    return {
      currentShow: {
        title: title,
        desc: desc,
        startStr: formatMinutesTo12Hour(startM),
        endStr: formatMinutesTo12Hour(endM),
        progress: progress,
        remainingMinutes: remainingMinutes
      },
      upcomingShows: upcomingShows
    };
  }

  function updateCurrentChannelEpg(channel) {
    const epg = getChannelEpgData(channel);

    // Update ON AIR Card
    el.nowShowTitle.textContent = epg.currentShow.title;
    el.nowShowDesc.textContent = epg.currentShow.desc;
    el.nowTimeRange.textContent = `${epg.currentShow.startStr} - ${epg.currentShow.endStr}`;
    el.nowStartLabel.textContent = epg.currentShow.startStr;
    el.nowEndLabel.textContent = epg.currentShow.endStr;
    el.nowRemainingLabel.textContent = `${epg.currentShow.remainingMinutes} min left (${epg.currentShow.progress}%)`;
    el.nowProgressFill.style.width = `${epg.currentShow.progress}%`;

    // Update UPCOMING Grid ("Ye itna time me aayega")
    let upcomingHtml = '';
    epg.upcomingShows.forEach((item, idx) => {
      upcomingHtml += `
        <div class="upcoming-item-card">
          <div class="upcoming-time-badge">
            <span class="time-slot">🕒 ${item.startTimeStr}</span>
            <span class="starts-in-badge">${item.startsInText}</span>
          </div>
          <div class="upcoming-title" title="${item.title}">${item.title}</div>
          <div class="upcoming-desc">${item.desc}</div>
        </div>`;
    });

    el.upcomingGrid.innerHTML = upcomingHtml;
  }

  // ============================================================
  // 4. CHANNEL LIST & CARDS (RIGHT PANE)
  // ============================================================
  function renderChannelList() {
    if (displayedChannels.length === 0) {
      el.channelListScroll.innerHTML = `
        <div style="text-align:center;padding:40px 16px;color:var(--text-muted);">
          🔍 No channels found for "${searchQuery}".
        </div>`;
      return;
    }

    let html = '';
    displayedChannels.forEach((ch, idx) => {
      const isPlaying = currentChannel && currentChannel.id === ch.id;
      const epg = getChannelEpgData(ch);
      const initials = ch.name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase();
      
      const logoHtml = ch.logo
        ? `<img class="card-logo-img" src="${ch.logo}" alt="${ch.name}" loading="lazy" onerror="this.outerHTML='<span style=\\'font-weight:800;color:var(--accent-cyan);\\'>${initials}</span>'">`
        : `<span style="font-weight:800;color:var(--accent-cyan);">${initials}</span>`;

      html += `
        <div class="channel-card-item ${isPlaying ? 'active-playing' : ''}" id="card_${ch.id}" onclick="selectChannelById(${ch.id})">
          <div class="card-logo-container" style="background:${ch.color ? ch.color + '33' : 'rgba(0,0,0,0.5)'}">
            ${logoHtml}
          </div>

          <div class="card-info">
            <div class="card-name-row">
              <span class="card-channel-name" title="${ch.name}">${ch.name}</span>
              <span class="quality-badge">${ch.badge || 'HD'}</span>
            </div>

            <div class="card-show-title" title="${epg.currentShow.title}">
              ▶ ${epg.currentShow.title}
            </div>

            <div class="card-schedule-time">
              <span>${epg.currentShow.startStr} - ${epg.currentShow.endStr}</span>
              <span style="color:var(--text-muted);">•</span>
              <span style="color:#00f260;">${epg.currentShow.remainingMinutes}m left</span>
            </div>
          </div>

          <!-- Playing animated equalizer -->
          <div class="equalizer-icon">
            <div class="eq-bar"></div>
            <div class="eq-bar"></div>
            <div class="eq-bar"></div>
          </div>
        </div>`;
    });

    el.channelListScroll.innerHTML = html;
  }

  function updateChannelListLiveShows() {
    displayedChannels.forEach(ch => {
      const card = document.getElementById(`card_${ch.id}`);
      if (card) {
        const epg = getChannelEpgData(ch);
        const titleEl = card.querySelector('.card-show-title');
        const timeEl = card.querySelector('.card-schedule-time');
        if (titleEl) titleEl.textContent = `▶ ${epg.currentShow.title}`;
        if (timeEl) {
          timeEl.innerHTML = `
            <span>${epg.currentShow.startStr} - ${epg.currentShow.endStr}</span>
            <span style="color:var(--text-muted);">•</span>
            <span style="color:#00f260;">${epg.currentShow.remainingMinutes}m left</span>`;
        }
      }
    });
  }

  window.selectChannelById = function (chId) {
    const ch = allChannels.find(c => c.id === chId);
    if (ch) {
      playChannel(ch);
    }
  };

  // ============================================================
  // 5. VIDEO STREAM PLAYBACK WITH HLS.JS
  // ============================================================
  function playChannel(ch) {
    currentChannel = ch;
    currentChannelIndex = displayedChannels.findIndex(c => c.id === ch.id);
    localStorage.setItem('novastream_last_channel_id', ch.id);

    // Highlight card
    document.querySelectorAll('.channel-card-item').forEach(c => c.classList.remove('active-playing'));
    const activeCard = document.getElementById(`card_${ch.id}`);
    if (activeCard) {
      activeCard.classList.add('active-playing');
      activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Update OSD
    el.osdChannelName.textContent = ch.name;
    el.osdCategoryBadge.textContent = ch.category;
    el.osdQualityBadge.textContent = ch.badge || 'LIVE';
    if (ch.logo) {
      el.osdLogo.src = ch.logo;
      el.osdLogo.style.display = 'block';
    } else {
      el.osdLogo.style.display = 'none';
    }

    triggerOsd();

    // Update Live EPG schedule banner
    updateCurrentChannelEpg(ch);

    // Setup Video Stream via Proxy if on local port 5000, else direct
    const isLocalServer = (window.location.port === '5000' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const proxyUrl = isLocalServer ? `/proxy/stream?url=${encodeURIComponent(ch.url)}` : ch.url;

    el.videoSpinner.style.display = 'flex';
    el.spinnerText.innerHTML = `Connecting to <strong>${ch.name}</strong>...`;
    streamRetryCount = 0;

    if (hls) {
      hls.destroy();
      hls = null;
    }

    if (Hls.isSupported()) {
      hls = new Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        maxBufferSize: 30 * 1000 * 1000,
        maxBufferLength: 15
      });

      hls.loadSource(proxyUrl);
      hls.attachMedia(el.videoPlayer);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        el.videoPlayer.play().then(() => {
          el.videoSpinner.style.display = 'none';
        }).catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              streamRetryCount++;
              if (streamRetryCount <= 2) {
                el.videoSpinner.style.display = 'flex';
                el.spinnerText.innerHTML = `<span style="color:#00d2ff;">Reconnecting feed (${streamRetryCount}/2)...</span>`;
                setTimeout(() => { if (hls) hls.startLoad(); }, 1200);
              } else {
                handleStreamFailure(ch);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              handleStreamFailure(ch);
              if (hls) hls.destroy();
              break;
          }
        }
      });

    } else if (el.videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Apple / Safari support
      el.videoPlayer.src = proxyUrl;
      el.videoPlayer.play().then(() => {
        el.videoSpinner.style.display = 'none';
      }).catch(() => {});
    }
  }

  function handleStreamFailure(ch) {
    el.videoSpinner.style.display = 'flex';
    const isGithub = window.location.hostname.includes('github.io');

    el.spinnerText.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:16px;">
        <span style="color:#ffb703;font-weight:800;font-size:16px;">⚠️ Direct Browser Playback Blocked</span>
        <span style="font-size:13px;color:rgba(255,255,255,0.85);max-width:320px;line-height:1.45;">
          ${isGithub ? 'GitHub Pages par browser CORS policy ke karan live stream block kar deta hai.' : 'Stream temporarily offline ya browser dwara blocked.'}
        </span>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px;">
          <button class="osd-quick-btn" style="background:var(--accent-cyan);color:#000;font-weight:800;" onclick="copyCurrentStreamUrl()">
            📋 Copy Link for VLC
          </button>
          <button class="osd-quick-btn" onclick="zapChannel(1)">
            Next Channel ▶
          </button>
        </div>
      </div>`;
  }

  // ============================================================
  // 6. PLAYER CONTROLS & AUDIOWORKLET / BOOST
  // ============================================================
  function initPlayerEvents() {
    el.videoPlayer.addEventListener('play', () => {
      el.playIcon.style.display = 'none';
      el.pauseIcon.style.display = 'block';
      el.videoSpinner.style.display = 'none';
    });

    el.videoPlayer.addEventListener('pause', () => {
      el.playIcon.style.display = 'block';
      el.pauseIcon.style.display = 'none';
    });

    el.videoPlayer.addEventListener('waiting', () => {
      el.videoSpinner.style.display = 'flex';
      el.spinnerText.textContent = 'Buffering stream...';
    });
  }

  window.togglePlay = function () {
    if (el.videoPlayer.paused) {
      el.videoPlayer.play();
    } else {
      el.videoPlayer.pause();
    }
  };

  window.zapChannel = function (delta) {
    if (displayedChannels.length === 0) return;
    if (currentChannelIndex === -1) {
      currentChannelIndex = 0;
    } else {
      currentChannelIndex = (currentChannelIndex + delta + displayedChannels.length) % displayedChannels.length;
    }
    const nextCh = displayedChannels[currentChannelIndex];
    if (nextCh) {
      playChannel(nextCh);
    }
  };

  window.setVolume = function (val) {
    el.videoPlayer.volume = val;
    el.videoPlayer.muted = (val === '0');
  };

  window.toggleMute = function () {
    el.videoPlayer.muted = !el.videoPlayer.muted;
    if (el.videoPlayer.muted) {
      el.volumeSlider.value = 0;
    } else {
      el.volumeSlider.value = el.videoPlayer.volume || 1;
    }
  };

  window.toggleAudioBoost = function () {
    if (!audioCtx) {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(el.videoPlayer);
        gainNode = audioCtx.createGain();
        source.connect(gainNode);
        gainNode.connect(audioCtx.destination);
      } catch (e) {
        console.warn('Audio boost not supported in this browser context:', e);
        return;
      }
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    isAudioBoosted = !isAudioBoosted;
    if (isAudioBoosted) {
      gainNode.gain.value = 2.0; // 200% volume
      el.audioBoostBtn.textContent = '200% 🔥';
      el.audioBoostBtn.style.color = '#00f260';
      showToast('Audio Boost 200% Enabled! 🔥');
    } else {
      gainNode.gain.value = 1.0;
      el.audioBoostBtn.textContent = '100%';
      el.audioBoostBtn.style.color = 'var(--accent-cyan)';
      showToast('Audio normal 100%');
    }
  };

  window.toggleAspectRatio = function () {
    currentAspectRatioIdx = (currentAspectRatioIdx + 1) % aspectRatios.length;
    const mode = aspectRatios[currentAspectRatioIdx];
    el.videoPlayer.style.objectFit = mode;
    showToast(`Aspect Ratio: ${mode.toUpperCase()}`);
  };

  window.togglePiP = function () {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else if (el.videoPlayer.requestPictureInPicture) {
      el.videoPlayer.requestPictureInPicture().catch(() => {});
    }
  };

  window.toggleFullscreen = function () {
    const box = document.getElementById('playerBox');
    if (!document.fullscreenElement) {
      box.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  function triggerOsd() {
    el.playerOsd.classList.add('visible');
    if (osdTimer) clearTimeout(osdTimer);
    osdTimer = setTimeout(() => {
      el.playerOsd.classList.remove('visible');
    }, 4000);
  }

  // ============================================================
  // 7. KEYBOARD SHORTCUTS
  // ============================================================
  function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (document.activeElement.tagName === 'INPUT') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowUp':
          e.preventDefault();
          zapChannel(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          zapChannel(1);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'p':
        case 'P':
          togglePiP();
          break;
        case '/':
          e.preventDefault();
          el.channelSearchInput.focus();
          break;
        case 'Escape':
          closeFullEpgModal();
          closeVlcGuideModal();
          break;
      }
    });

    el.channelSearchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      el.searchClearBtn.style.display = searchQuery ? 'block' : 'none';
      filterChannels();
    });
  }

  // ============================================================
  // 8. CATEGORY & SEARCH FILTERING
  // ============================================================
  window.filterCategory = function (cat) {
    activeCategory = cat;
    document.querySelectorAll('.cat-pill').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('onclick').includes(`'${cat}'`));
    });
    filterChannels();
  };

  window.clearSearch = function () {
    el.channelSearchInput.value = '';
    searchQuery = '';
    el.searchClearBtn.style.display = 'none';
    filterChannels();
  };

  function filterChannels() {
    let pool = allChannels;

    if (activeCategory !== 'ALL') {
      pool = pool.filter(c => c.category.toLowerCase() === activeCategory.toLowerCase());
    }

    if (searchQuery) {
      pool = pool.filter(c => {
        const matchesName = c.name.toLowerCase().includes(searchQuery);
        const matchesCategory = c.category.toLowerCase().includes(searchQuery);
        const matchesShow = (c.schedule || []).some(s => s[2].toLowerCase().includes(searchQuery));
        return matchesName || matchesCategory || matchesShow;
      });
    }

    displayedChannels = pool;
    el.channelCountBadge.textContent = `${pool.length} Channels`;
    renderChannelList();
  }

  // ============================================================
  // 9. MODALS: 24-HOUR EPG & VLC GUIDE
  // ============================================================
  window.openFullEpgModal = function () {
    if (!currentChannel) return;
    el.fullEpgModalTitle.textContent = `📅 24-Hour Schedule: ${currentChannel.name}`;

    const schedule = currentChannel.schedule || [];
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();

    let html = '';
    schedule.forEach((item, idx) => {
      let startM = parseTimeToMinutes(item[0]);
      let endM = parseTimeToMinutes(item[1]);
      let isCurrent = false;

      if (endM < startM) {
        if (currentMins >= startM || currentMins < endM) isCurrent = true;
      } else {
        if (currentMins >= startM && currentMins < endM) isCurrent = true;
      }

      const start12 = formatMinutesTo12Hour(startM);
      const end12 = formatMinutesTo12Hour(endM);

      html += `
        <div class="epg-timeline-row ${isCurrent ? 'is-current' : ''}">
          <div class="timeline-time-col">
            <span>${start12} - ${end12}</span>
            ${isCurrent ? '<span style="color:#00f260;font-size:10px;">● ON AIR NOW</span>' : ''}
          </div>
          <div class="timeline-info-col">
            <div class="timeline-show-name">${item[2]}</div>
            <div class="timeline-show-desc">${item[3]}</div>
          </div>
        </div>`;
    });

    el.fullEpgModalBody.innerHTML = html;
    el.fullEpgModal.style.display = 'flex';
  };

  window.closeFullEpgModal = function () {
    el.fullEpgModal.style.display = 'none';
  };

  window.openVlcGuideModal = function () {
    if (currentChannel) {
      el.vlcModalStreamUrl.textContent = currentChannel.url;
    }
    el.vlcGuideModal.style.display = 'flex';
  };

  window.closeVlcGuideModal = function () {
    el.vlcGuideModal.style.display = 'none';
  };

  window.copyCurrentStreamUrl = function () {
    if (!currentChannel) return;
    navigator.clipboard.writeText(currentChannel.url).then(() => {
      showToast('Stream link copied! Ready for VLC ✓');
    }).catch(() => {
      prompt('Copy Stream Link:', currentChannel.url);
    });
  };

  function showToast(msg) {
    el.toastMsg.textContent = msg;
    el.toastMsg.style.display = 'block';
    setTimeout(() => {
      el.toastMsg.style.display = 'none';
    }, 2200);
  }

})();
