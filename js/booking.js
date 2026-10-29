/**
 * ============================================================================
 * EVENTPAY CUSTOMER ONLINE BOOKING CONTROLLER (js/booking.js)
 * โครงการ: EventPay (Concert Payment & Secure Entry Platform)
 * พิกัด: D:\BillingApp\Antigravity\EventPay\js\booking.js
 * หน้าที่: ควบคุมตรรกะหน้าจองบัตรออนไลน์ของลูกค้า (Customer Self-Service)
 *        รวมขั้นตอนเดียว: เลือกบัตร ➔ สแกนพร้อมเพย์ ➔ ตรวจสลิป ➔ ออกตั๋ว e-Ticket QR
 * ============================================================================
 */

(function () {
  'use strict';

  let bookingQuantities = {};
  let audioAlert = null;
  let qrcodeInstance = null;
  let attachedSlipBase64 = null;
  let waitingPollInterval = null;
  let waitingCountdownInterval = null;
  let currentWaitingOrderId = null;
  let currentSmartCents = 0.00;
  let systemCPollingInterval = null;
  let zeroSlipCountdownInterval = null;
  let currentPaymentConfig = { mode: 'system_c', smart_cents_enabled: false };
  let lastBookingResult = null;

  document.addEventListener('DOMContentLoaded', () => {
    try {
      if (typeof EventPayAudioAlert !== 'undefined') {
        audioAlert = new EventPayAudioAlert();
      }
    } catch (e) {
      console.warn('[Booking] Audio alert warning:', e);
    }
    initBookingPage();
  });

  function initBookingPage() {
    initBookingUiMode();
    initPaymentMode();
    loadEventDetails();
    renderTiers();
    syncTiersFromMaster();
    updateBookingSummary();
    setupInputListeners();
    setupSSEListener();

    // คีย์ลัดสลับโหมด Alt+T สำหรับผู้ดูแลระบบ
    window.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        toggleBookingUiMode();
      }
    });

    // ปลดล็อก Web Audio เมื่อผู้ใช้แตะหน้าจอครั้งแรก
    document.addEventListener('click', function unlockOnce() {
      if (audioAlert) audioAlert.unlockAudio();
      document.removeEventListener('click', unlockOnce);
    }, { once: true });
  }

  function syncTiersFromMaster() {
    if (typeof fetch === 'undefined') return;
    const apiUrl = (typeof EventPayDB !== 'undefined' && typeof EventPayDB.getApiUrl === 'function')
      ? EventPayDB.getApiUrl('/api/db/ticket_tiers')
      : ((typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:8080/api/db/ticket_tiers' : '/api/db/ticket_tiers');
    fetch(apiUrl)
      .then(r => r.json())
      .then(tiers => {
        if (Array.isArray(tiers) && tiers.length > 0) {
          if (typeof EventPayDB !== 'undefined') {
            EventPayDB._saveCollection('ticket_tiers', tiers);
          }
          renderTiers();
          updateBookingSummary();
        }
      })
      .catch(() => {});
  }

  function initPaymentMode() {
    if (typeof EventPayDB !== 'undefined' && EventPayDB.getPaymentConfig) {
      currentPaymentConfig = EventPayDB.getPaymentConfig();
    }
    if (typeof fetch !== 'undefined') {
      fetch('/api/payment/config')
        .then(r => r.json())
        .then(d => {
          if (d && d.success && d.config) {
            currentPaymentConfig = d.config;
            applyPaymentModeUI(currentPaymentConfig.mode);
          }
        })
        .catch(() => {});
    }
    applyPaymentModeUI(currentPaymentConfig ? currentPaymentConfig.mode : 'system_c');
  }

  function applyPaymentModeUI(mode) {
    const legacySlipArea = document.getElementById('bookingLegacySlipArea');
    const zeroSlipRadar = document.getElementById('zeroSlipLiveRadar');
    const step3Title = document.getElementById('bookingStep3Title');
    const btnSubmit = document.getElementById('btnSubmitBooking');

    // [POINT 1]: แสดงพื้นที่แนบสลิปเสมอ เพื่อให้ลูกค้าแนบสลิปเพื่อรับตั๋วทันที 1.5 วินาที
    if (legacySlipArea) legacySlipArea.style.display = 'block';

    if (mode === 'system_c') {
      if (zeroSlipRadar) zeroSlipRadar.style.display = 'block';
      if (step3Title) step3Title.textContent = 'ชำระเงินผ่านพร้อมเพย์ / แนบสลิปรับตั๋วทันที';
      if (btnSubmit) {
        btnSubmit.innerHTML = attachedSlipBase64 ? '⚡ ยืนยันและรับตั๋ว QR ทันที (ตรวจพบสลิปแนบ)' : '⚡ ยืนยันการจองและรับตั๋ว e-Ticket ทันที';
        btnSubmit.style.background = 'linear-gradient(135deg, #059669 0%, #10b981 100%)';
        btnSubmit.style.boxShadow = '0 4px 18px rgba(16, 185, 129, 0.4)';
      }
    } else {
      if (zeroSlipRadar) zeroSlipRadar.style.display = 'none';
      if (step3Title) step3Title.textContent = 'ชำระเงินและแนบสลิป';
      if (btnSubmit) {
        btnSubmit.innerHTML = '⚡ ยืนยันการจองและรับตั๋ว e-Ticket ทันที';
        btnSubmit.style.background = 'linear-gradient(135deg, #059669 0%, #10b981 100%)';
        btnSubmit.style.boxShadow = '0 4px 18px rgba(16, 185, 129, 0.4)';
      }
    }
  }

  function startZeroSlipCountdown(seconds = 180) {
    if (zeroSlipCountdownInterval) clearInterval(zeroSlipCountdownInterval);
    let remaining = seconds;
    const timerEl = document.getElementById('zeroSlipCountdownTimer');

    function update() {
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      if (timerEl) {
        timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }
      if (remaining <= 0) {
        clearInterval(zeroSlipCountdownInterval);
        if (timerEl) timerEl.textContent = 'หมดอายุ';
      }
      remaining--;
    }

    update();
    zeroSlipCountdownInterval = setInterval(update, 1000);
  }

  function setupSSEListener() {
    if (typeof EventSource !== 'undefined') {
      try {
        const sseUrl = (typeof EventPayDB !== 'undefined' && typeof EventPayDB.getApiUrl === 'function')
          ? EventPayDB.getApiUrl('/api/events')
          : ((typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:8080/api/events' : '/api/events');
        const evtSource = new EventSource(sseUrl);
        evtSource.addEventListener('PAYMENT_CONFIRMED', function (e) {
          try {
            const data = JSON.parse(e.data);
            if (currentWaitingOrderId && data.orderId === currentWaitingOrderId) {
              handlePaymentSuccessAuto(data.orderId);
            }
          } catch (err) {
            console.warn('[SSE] Parse error:', err);
          }
        });
        evtSource.addEventListener('PAYMENT_CONFIG_CHANGED', function (e) {
          try {
            const newConfig = JSON.parse(e.data);
            currentPaymentConfig = newConfig;
            applyPaymentModeUI(newConfig.mode);
            updateBookingSummary();
          } catch (err) {}
        });
        evtSource.addEventListener('TIERS_SYNCED', function (e) {
          try {
            syncTiersFromMaster();
          } catch (err) {}
        });
      } catch (err) {
        console.warn('[SSE] EventSource init warning:', err);
      }
    }
  }

  function handlePaymentSuccessAuto(orderId) {
    if (zeroSlipCountdownInterval) clearInterval(zeroSlipCountdownInterval);
    if (systemCPollingInterval) clearInterval(systemCPollingInterval);
    if (waitingPollInterval) clearInterval(waitingPollInterval);
    if (waitingCountdownInterval) clearInterval(waitingCountdownInterval);

    if (audioAlert) {
      try { audioAlert.playValidPass(); } catch (e) {}
    }

    if (typeof EventPayDB !== 'undefined') {
      const order = EventPayDB.get('orders', orderId);
      const payment = EventPayDB.getAll('payments', p => p.order_id === orderId)[0] || null;
      const tickets = EventPayDB.getAll('tickets', t => t.order_id === orderId && !t.is_void);
      displayBookingSuccess({ order, payment, tickets });
    }
  }

  function loadEventDetails() {
    if (typeof EventPayDB === 'undefined') return;
    const events = EventPayDB.getAll('events');
    if (events && events.length > 0) {
      const evt = events[0];
      const nameEl = document.getElementById('bookingEventName');
      const venueEl = document.getElementById('bookingVenue');
      if (nameEl) nameEl.textContent = evt.name;
      if (venueEl) venueEl.textContent = `${evt.venue} | ${new Date(evt.start_date).toLocaleDateString('th-TH')}`;
    }
  }

  function renderTiers() {
    if (typeof EventPayDB === 'undefined') return;
    const tiers = EventPayDB.getAll('ticket_tiers');
    const container = document.getElementById('bookingTierGrid');
    if (!container) return;
    container.innerHTML = '';

    tiers.forEach((tier, index) => {
      /* [REMARKED BY THEP-APAI & LILIN: โค้ดเดิมบังคับให้โซนแรกเป็น 1 ใบ ทำให้หน้าเว็บล็อกจำนวนบัตรไว้]
      if (!(tier.tier_id in bookingQuantities)) {
        bookingQuantities[tier.tier_id] = (index === 0 ? 1 : 0);
      }
      */
      // [INSERT ACTIVE MODERN LOGIC]: ปลดล็อกทุกราคาบัตรเริ่มต้นเป็น 0 ทั้งหมดตามคำสั่งเทพอภัย
      if (!(tier.tier_id in bookingQuantities)) {
        bookingQuantities[tier.tier_id] = 0;
      }

      const isSelected = bookingQuantities[tier.tier_id] > 0;
      const card = document.createElement('div');
      card.className = `ep-tier-item ${isSelected ? 'selected' : ''}`;
      card.id = `tier_card_${tier.tier_id}`;

      card.innerHTML = `
        <div class="ep-tier-info">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <span class="ep-tier-name">${tier.name}</span>
            <span class="ep-tier-badge" id="badge_${tier.tier_id}" style="display: ${isSelected ? 'inline-block' : 'none'}; background: var(--accent-gold); color: #000; font-size: 0.72rem; font-weight: 800; padding: 2px 8px; border-radius: 12px;">✓ เลือกแล้ว</span>
          </div>
          <div class="ep-tier-meta">
            <span>ความจุ: ${(tier.capacity || tier.quota || 0).toLocaleString()} ที่นั่ง</span>
          </div>
        </div>
        <div class="ep-tier-price-col">
          <div class="ep-tier-price">฿${tier.price.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</div>
        </div>
        <div class="ep-qty-control">
          <button type="button" class="ep-qty-btn" onclick="changeTierQuantity('${tier.tier_id}', -1, event)" aria-label="ลด">-</button>
          <input type="number" 
                 id="qty_val_${tier.tier_id}" 
                 class="ep-qty-input" 
                 value="${bookingQuantities[tier.tier_id]}" 
                 min="0" 
                 max="999" 
                 step="1"
                 inputmode="numeric"
                 pattern="[0-9]*"
                 onfocus="handleQtyFocus(this, '${tier.tier_id}')" 
                 onblur="handleQtyBlur(this, '${tier.tier_id}')" 
                 oninput="handleQtyInput(this, '${tier.tier_id}')" 
                 onclick="handleQtyClick(this, '${tier.tier_id}', event)"
                 aria-label="จำนวนบัตร ${tier.name}">
          <button type="button" class="ep-qty-btn" onclick="changeTierQuantity('${tier.tier_id}', 1, event)" aria-label="เพิ่ม">+</button>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.ep-qty-btn') || e.target.closest('.ep-qty-input')) return;
        if (bookingQuantities[tier.tier_id] === 0) {
          bookingQuantities[tier.tier_id] = 1;
        }
        updateTierUI();
        updateBookingSummary();
      });

      container.appendChild(card);
    });
  }

  window.changeTierQuantity = function (tierId, delta, event) {
    if (event) event.stopPropagation();
    const current = bookingQuantities[tierId] || 0;
    const updated = Math.max(0, current + delta);
    bookingQuantities[tierId] = updated;

    updateTierUI();
    updateBookingSummary();
  };

  // Direct number input event handlers
  window.handleQtyFocus = function (input, tierId) {
    // ในช่องตัวเลข จะเป็นเลขอะไร ถ้าจิ้มหรือกดลงจุดนี้ ตัวเลขจะหายไป สามารถคีย์เลขอื่นได้ทันที
    input.value = '';
    bookingQuantities[tierId] = 0;
    updateTierCardState(tierId);
    updateBookingSummary();
  };

  window.handleQtyClick = function (input, tierId, event) {
    if (event) event.stopPropagation();
    // รองรับกรณีที่จิ้มหรือกดซ้ำในช่องขณะโฟกัสอยู่แล้ว ให้ตัวเลขหายไป สามารถคีย์เลขอื่นได้ทันที
    input.value = '';
    bookingQuantities[tierId] = 0;
    updateTierCardState(tierId);
    updateBookingSummary();
  };

  window.handleQtyInput = function (input, tierId) {
    const raw = input.value.trim();
    if (raw === '') {
      bookingQuantities[tierId] = 0;
    } else {
      const val = parseInt(raw, 10);
      bookingQuantities[tierId] = isNaN(val) || val < 0 ? 0 : Math.min(val, 999);
    }
    updateTierCardState(tierId);
    updateBookingSummary();
  };

  window.handleQtyBlur = function (input, tierId) {
    const raw = input.value.trim();
    if (raw === '' || isNaN(raw) || parseInt(raw, 10) < 0) {
      input.value = '0';
      bookingQuantities[tierId] = 0;
    } else {
      const val = Math.min(parseInt(raw, 10), 999);
      input.value = val.toString();
      bookingQuantities[tierId] = val;
    }
    updateTierCardState(tierId);
    updateBookingSummary();
  };

  function updateTierCardState(tierId) {
    const qty = bookingQuantities[tierId] || 0;
    const card = document.getElementById(`tier_card_${tierId}`);
    const badge = document.getElementById(`badge_${tierId}`);
    if (card) {
      if (qty > 0) {
        card.classList.add('selected');
        if (badge) badge.style.display = 'inline-block';
      } else {
        card.classList.remove('selected');
        if (badge) badge.style.display = 'none';
      }
    }
  }

  function updateTierUI() {
    Object.keys(bookingQuantities).forEach(tierId => {
      const qty = bookingQuantities[tierId];
      const card = document.getElementById(`tier_card_${tierId}`);
      const val = document.getElementById(`qty_val_${tierId}`);
      const badge = document.getElementById(`badge_${tierId}`);
      if (val) {
        if (document.activeElement !== val) {
          val.value = qty;
        }
        val.textContent = qty;
      }
      if (card) {
        if (qty > 0) {
          card.classList.add('selected');
          if (badge) badge.style.display = 'inline-block';
        } else {
          card.classList.remove('selected');
          if (badge) badge.style.display = 'none';
        }
      }
    });
  }

  function getBookingTotalAmount() {
    if (typeof EventPayDB === 'undefined') return 0;
    const tiers = EventPayDB.getAll('ticket_tiers');
    let total = 0;
    tiers.forEach(tier => {
      const qty = bookingQuantities[tier.tier_id] || 0;
      total += (tier.price * qty);
    });
    return total;
  }

  function getBookingTotalTickets() {
    let count = 0;
    Object.values(bookingQuantities).forEach(qty => { count += qty; });
    return count;
  }

  function getEffectiveTotal(baseTotal) {
    currentSmartCents = 0.00;
    if (baseTotal <= 0) return 0;
    // บัตรคอนเสิร์ตไม่มียอดเงินเป็นสตางค์ เป็นยอดเต็มจำนวนบาทถ้วนเสมอ
    return Math.round(baseTotal);
  }

  function updateBookingSummary() {
    const total = getBookingTotalAmount();
    const count = getBookingTotalTickets();
    const effectiveTotal = getEffectiveTotal(total);

    const countEl = document.getElementById('bookingTotalCount');
    const totalEl = document.getElementById('bookingTotalAmount');
    const qrTotalEl = document.getElementById('bookingPromptPayTotal');

    if (countEl) countEl.textContent = `${count} ใบ`;
    if (totalEl) totalEl.textContent = `฿${effectiveTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    if (qrTotalEl) qrTotalEl.textContent = `฿${effectiveTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

    renderAttendeeInputs(count);
    renderPromptPayQr(effectiveTotal);
    validateFormReadiness();

    if (count > 0 && effectiveTotal > 0 && currentPaymentConfig && currentPaymentConfig.mode === 'system_c') {
      startZeroSlipCountdown(180);
    }
  }

  function renderAttendeeInputs(totalCount) {
    const container = document.getElementById('bookingAttendeeContainer');
    if (!container) return;
    container.innerHTML = '';

    if (totalCount > 1) {
      const header = document.createElement('div');
      header.style.fontSize = '0.82rem';
      header.style.color = 'var(--accent-gold)';
      header.style.fontWeight = '700';
      header.style.marginBottom = '8px';
      header.textContent = `🎟️ ระบุชื่อผู้ถือบัตรเพิ่มเติม (สำหรับบัตร ${totalCount} ใบ):`;
      container.appendChild(header);

      let attendeeIdx = 1;
      const tiers = EventPayDB.getAll('ticket_tiers');
      tiers.forEach(tier => {
        const qty = bookingQuantities[tier.tier_id] || 0;
        for (let i = 0; i < qty; i++) {
          if (attendeeIdx > 1) {
            const row = document.createElement('div');
            row.style.marginBottom = '8px';
            row.innerHTML = `
              <label class="ep-form-label" style="font-size: 0.78rem;">
                ผู้เข้าชมคนที่ ${attendeeIdx} (${tier.name})
              </label>
              <input type="text" class="ep-input booking-attendee-input"
                     data-tier="${tier.tier_id}"
                     placeholder="ชื่อ-นามสกุล ผู้ถือบัตรใบที่ ${attendeeIdx}">
            `;
            container.appendChild(row);
          }
          attendeeIdx++;
        }
      });
    }
  }

  function renderPromptPayQr(amount) {
    const holder = document.getElementById('bookingPromptPayQr');
    const accInfoEl = document.getElementById('bookingPromptPayAccInfo');
    if (!holder) return;
    holder.innerHTML = '';

    // ดึงข้อมูลบัญชีธนาคารหลักที่เปิดใช้งานจริงจาก EventPayDB
    let activeBank = null;
    if (typeof EventPayDB !== 'undefined' && EventPayDB.getActiveBankAccount) {
      activeBank = EventPayDB.getActiveBankAccount();
    }
    const bankName = activeBank ? activeBank.bank_name : 'ธนาคารกสิกรไทย (KBANK)';
    const accNum = activeBank ? activeBank.account_number : '081-234-5678';
    const accName = activeBank ? activeBank.account_name : 'บริษัท สุรเทพอภัย คอนเสิร์ต จำกัด (EventPay Official)';
    const promptPayId = activeBank ? activeBank.promptpay_id : '0812345678';

    // อัปเดตข้อมูลบัญชีผู้รับเงินแบบไดนามิก
    if (accInfoEl) {
      accInfoEl.innerHTML = `
        <div style="font-weight: 700; color: #fff; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
          <span>🏦 โอนเงินเข้าบัญชี:</span>
        </div>
        <div style="color: var(--accent-gold); font-weight: 700; font-size: 0.95rem;">${escapeHtml(bankName)}</div>
        <div style="margin-top: 2px;">เลขที่บัญชี: <strong style="font-family: monospace; font-size: 1.05rem; color: #fff; background: rgba(255,255,255,0.08); padding: 1px 6px; border-radius: 4px;">${escapeHtml(accNum)}</strong></div>
        <div style="margin-top: 2px;">ชื่อบัญชี: <strong style="color: #e2e8f0;">${escapeHtml(accName)}</strong></div>
        <div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.15); color: #94a3b8; font-size: 0.8rem;">
          พร้อมเพย์: <strong style="color: var(--accent-cyan); font-family: monospace; font-size: 0.95rem;">${escapeHtml(promptPayId)}</strong>
        </div>
      `;
    }

    if (typeof QRCode !== 'undefined' && amount > 0) {
      /* [REMARKED BY THEP-APAI & LILIN: โค้ดเดิมฟิกซ์เบอร์พร้อมเพย์ 0812345678]
      const payload = `TH.GOV.PROMPTPAY|0812345678|AMOUNT:${amount.toFixed(2)}|EVENTPAY-CONCERT-2026`;
      */
      // [INSERT ACTIVE MODERN LOGIC]: ดึงเบอร์พร้อมเพย์จากบัญชีหลักที่เปิดใช้งานจริง
      const cleanPromptPayId = promptPayId.replace(/[^0-9]/g, '');
      const payload = `TH.GOV.PROMPTPAY|${cleanPromptPayId}|AMOUNT:${amount.toFixed(2)}|EVENTPAY-CONCERT-2026`;
      new QRCode(holder, {
        text: payload,
        width: 170,
        height: 170,
        colorDark: '#002d62',
        colorLight: '#ffffff'
      });
    } else if (amount === 0) {
      holder.innerHTML = '<span style="font-size:0.75rem; color:#999;">เลือกบัตรเพื่อดู QR พร้อมเพย์</span>';
    }
  }

  function setupInputListeners() {
    ['bookingCustName', 'bookingCustPhone', 'bookingBankRefInput'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', validateFormReadiness);
      }
    });
  }

  // ==========================================================================
  // REAL SLIP IMAGE UPLOAD & CANVAS COMPRESSION (RULE 14)
  // ==========================================================================
  window.handleSlipFileSelect = function (event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('กรุณาเลือกไฟล์รูปภาพ (JPG, PNG) เท่านั้นค่ะ');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        // บีบอัดรูปภาพด้วย HTML5 Canvas (Rule 14: Face & Slip Optimization)
        const maxDimension = 900;
        let width = img.width;
        let height = img.height;

        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // แปลงเป็น Base64 JPEG คุณภาพ 0.82
        attachedSlipBase64 = canvas.toDataURL('image/jpeg', 0.82);

        // แสดงผล Preview
        const previewImg = document.getElementById('bookingSlipPreviewImg');
        const fileNameEl = document.getElementById('bookingSlipFileName');
        const previewContainer = document.getElementById('bookingSlipPreviewContainer');
        const uploadZone = document.getElementById('bookingSlipUploadZone');
        const statusText = document.getElementById('bookingSlipStatus');

        if (previewImg) previewImg.src = attachedSlipBase64;
        if (fileNameEl) {
          const fileSizeKb = Math.round(attachedSlipBase64.length * 0.75 / 1024);
          fileNameEl.textContent = `${file.name} (${fileSizeKb} KB)`;
        }
        if (previewContainer) previewContainer.style.display = 'block';
        if (uploadZone) uploadZone.style.borderColor = '#10b981';
        if (statusText) statusText.textContent = '✓ แนบรูปภาพสลิปโอนเงินเรียบร้อยแล้ว พร้อมกดยืนยันการจอง';

        // ป้อนค่ายอดเงินที่โอนในสลิปให้อัตโนมัติตามยอดจอง
        const slipAmountInput = document.getElementById('bookingSlipAmountInput');
        if (slipAmountInput) {
          const currentTotal = getBookingTotalAmount();
          slipAmountInput.value = currentTotal > 0 ? currentTotal.toFixed(2) : '0.00';
        }
        const mismatchAlert = document.getElementById('bookingAmountMismatchAlert');
        if (mismatchAlert) mismatchAlert.style.display = 'none';

        validateFormReadiness();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  window.removeAttachedSlip = function (event) {
    if (event) event.stopPropagation();
    attachedSlipBase64 = null;
    const fileInput = document.getElementById('bookingSlipFileInput');
    if (fileInput) fileInput.value = '';

    const previewContainer = document.getElementById('bookingSlipPreviewContainer');
    const uploadZone = document.getElementById('bookingSlipUploadZone');
    const statusText = document.getElementById('bookingSlipStatus');
    const mismatchAlert = document.getElementById('bookingAmountMismatchAlert');

    if (previewContainer) previewContainer.style.display = 'none';
    if (uploadZone) uploadZone.style.borderColor = '#38bdf8';
    if (statusText) statusText.textContent = '';
    if (mismatchAlert) mismatchAlert.style.display = 'none';

    validateFormReadiness();
  };

  window.simulateZeroSlipWebhook = async function () {
    const btn = document.getElementById('btnSimulateZeroSlipWebhook') || document.querySelector('#zeroSlipLiveRadar button');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '⏳ กำลังจำลองเงินเข้าจากธนาคาร...';
      btn.style.opacity = '0.75';
    }

    try {
      // 1. ตรวจสอบว่ามีคำสั่งซื้อค้างอยู่หรือไม่ หากไม่มี ให้เตรียมคำสั่งซื้อให้อัตโนมัติทันที (Smart One-Click)
      let targetOrderId = currentWaitingOrderId;
      let orderObj = (targetOrderId && typeof EventPayDB !== 'undefined') ? EventPayDB.get('orders', targetOrderId) : null;

      if (!orderObj || orderObj.payment_status === 'PAID') {
        // ดึงข้อมูลจากฟอร์มหน้าจอ
        const custNameInput = document.getElementById('bookingCustName');
        const custPhoneInput = document.getElementById('bookingCustPhone');
        let custName = (custNameInput?.value || '').trim();
        let custPhone = (custPhoneInput?.value || '').trim();

        if (!custName) {
          custName = 'สมชาย ใจดี (ลูกค้าจองด่วน)';
          if (custNameInput) custNameInput.value = custName;
        }
        if (!custPhone) {
          custPhone = '081-987-6543';
          if (custPhoneInput) custPhoneInput.value = custPhone;
        }

        // ตรวจสอบจำนวนบัตร หากยังไม่ได้เลือก ให้เลือกบัตรแถวแรกอัตโนมัติ (เช่น VIP 1 ใบ)
        let totalQty = getBookingTotalTickets();
        if (totalQty === 0) {
          const tiers = (typeof EventPayDB !== 'undefined') ? EventPayDB.getAll('ticket_tiers') : [];
          if (tiers && tiers.length > 0) {
            bookingQuantities[tiers[0].tier_id] = 1;
            const qtyInput = document.getElementById(`qty_val_${tiers[0].tier_id}`);
            if (qtyInput) qtyInput.value = 1;
            const badge = document.getElementById(`badge_${tiers[0].tier_id}`);
            if (badge) badge.style.display = 'inline-block';
            const card = document.getElementById(`tier_card_${tiers[0].tier_id}`);
            if (card) card.classList.add('selected');
            updateBookingSummary();
          }
        }

        // สร้างรายการบัตร
        const items = [];
        const allTiers = (typeof EventPayDB !== 'undefined') ? EventPayDB.getAll('ticket_tiers') : [];
        allTiers.forEach(t => {
          const q = bookingQuantities[t.tier_id] || 0;
          if (q > 0) {
            items.push({
              tier_id: t.tier_id,
              quantity: q,
              attendee_names: [custName]
            });
          }
        });
        if (items.length === 0 && allTiers.length > 0) {
          items.push({ tier_id: allTiers[0].tier_id, quantity: 1, attendee_names: [custName] });
        }

        const newOrderId = 'ORD-' + Date.now();
        const orderData = {
          order_id: newOrderId,
          customer_name: custName,
          customer_phone: custPhone,
          payment_method: 'TRANSFER',
          shift_id: 'SHIFT-ONLINE-SELF',
          bank_ref: 'AUTO-PROMPTPAY-' + Date.now().toString().slice(-6),
          slip_url: '',
          requires_verification: true,
          items: items
        };

        // บันทึกคำสั่งซื้อลงใน Client LocalStorage
        const localCreated = EventPayDB.createOrder(orderData, 'ONLINE_CUSTOMER');
        currentWaitingOrderId = localCreated.order.order_id;
        targetOrderId = currentWaitingOrderId;
        orderObj = localCreated.order;

        // ซิงก์คำสั่งซื้อขึ้น Master Server (หากออนไลน์) เพื่อให้ตู้ Kiosk และ Server DB รับรู้พร้อมกันทันที
        const apiUrlOrder = (typeof EventPayDB !== 'undefined' && typeof EventPayDB.getApiUrl === 'function')
          ? EventPayDB.getApiUrl('/api/orders/create')
          : ((typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:8080/api/orders/create' : '/api/orders/create');
        try {
          await fetch(apiUrlOrder, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderData: { ...orderData, order_id: targetOrderId }, cashierId: 'ONLINE_CUSTOMER' })
          });
        } catch (eOrderSync) {
          console.warn('[Simulate Zero-Slip] Master server order sync warn (continuing offline):', eOrderSync);
        }
      }

      // 2. ดึงยอดเงินและสร้างรหัสธุรกรรมจำลอง
      const totalAmount = orderObj ? orderObj.total_amount : (getEffectiveTotal(getBookingTotalAmount()) || 2000.00);
      const custName = orderObj ? orderObj.customer_name : 'สมชาย ใจดี';
      const simRef = 'KBANK-BOT-' + Date.now().toString().slice(-8);

      const payload = {
        amount: totalAmount,
        order_id: targetOrderId,
        bank: 'KBANK',
        bank_ref: simRef,
        sender_name: custName,
        timestamp: new Date().toISOString()
      };

      console.log('[Simulate Zero-Slip Webhook] Triggering bank notification payload:', payload);

      // 3. ส่งสัญญาณ Webhook ไปยัง Master Server (ถ้ามี)
      const apiUrlNotif = (typeof EventPayDB !== 'undefined' && typeof EventPayDB.getApiUrl === 'function')
        ? EventPayDB.getApiUrl('/api/payment/notification')
        : ((typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:8080/api/payment/notification' : '/api/payment/notification');

      try {
        const res = await fetch(apiUrlNotif, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data && data.success) {
          console.log('[Simulate Zero-Slip Webhook] Server confirmed successfully:', data);
        }
      } catch (eFetch) {
        console.warn('[Simulate Zero-Slip Webhook] Server notification fetch warn:', eFetch);
      }

      // 4. การันตี 100% ในฐานข้อมูล Local Client (Fail-Safe Dual Confirmation)
      if (typeof EventPayDB !== 'undefined') {
        EventPayDB.autoConfirmPromptPayPayment(payload, 'AUTO-BOT-ZERO-SLIP');
      }

      // 5. แสดงผลลัพธ์ Visual Feedback และปลดล็อกหน้าจอออกตั๋วทันที
      if (btn) {
        btn.innerHTML = `✅ ได้รับเงินโอน ฿${totalAmount.toLocaleString()} สำเร็จ!`;
        btn.style.background = 'rgba(16, 185, 129, 0.4)';
      }

      if (audioAlert) {
        try { audioAlert.playValidPass(); } catch (e) {}
      }

      const notice = document.getElementById('bookingValidationNotice');
      if (notice) {
        notice.innerHTML = `<span style="color: #34d399; font-weight: 700;">⚡ ได้รับแจ้งเงินเข้าจากธนาคารกสิกรไทย ฿${totalAmount.toLocaleString()} ➔ ปลดล็อกตั๋วสำเร็จ!</span>`;
      }

      // ปลดล็อกหน้าจอออกตั๋ว e-Ticket QR Code และใบเสร็จรับเงิน
      setTimeout(() => {
        handlePaymentSuccessAuto(targetOrderId);
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalText || '⚡ ทดสอบจำลองธนาคารแจ้งเงินเข้า (Bot 1.5 วินาที)';
          btn.style.opacity = '1';
        }
      }, 500);

    } catch (err) {
      console.error('[Simulate Zero-Slip Webhook] Fatal error in simulation flow:', err);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText || '⚡ ทดสอบจำลองธนาคารแจ้งเงินเข้า (Bot 1.5 วินาที)';
        btn.style.opacity = '1';
      }
      alert('⚠️ การจำลองขัดข้อง: ' + err.message);
    }
  };

  window.simulateFastSlip = function () {
    const refInput = document.getElementById('bookingBankRefInput');
    const statusText = document.getElementById('bookingSlipStatus');
    const uniqueRef = 'KBANK-ONL-' + Date.now().toString().slice(-8);

    if (refInput) refInput.value = uniqueRef;

    // สร้างภาพสลิปจำลองด้วย Canvas ให้มีลักษณะเสมือนสลิปโอนเงินจริง
    const canvas = document.createElement('canvas');
    canvas.width = 460;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');

    // พื้นหลังสีขาว
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 460, 640);

    // แถบหัวสีเขียวธนาคารกสิกรไทย
    ctx.fillStyle = '#138f2d';
    ctx.fillRect(0, 0, 460, 80);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('K PLUS | โอนเงินสำเร็จ', 20, 48);

    // รายละเอียดผู้รับโอน
    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('โอนไปยัง:', 20, 120);

    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#334155';
    ctx.fillText('บริษัท ไอซ์ โปรซาวด์ จำกัด', 20, 148);
    ctx.fillText('ธนาคารกสิกรไทย (KBANK)', 20, 172);
    ctx.fillText('เลขที่บัญชี: 081-2-34567-8', 20, 196);

    // เส้นคั่น
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(20, 220);
    ctx.lineTo(440, 220);
    ctx.stroke();

    // ยอดเงินโอน
    const totalAmount = getBookingTotalAmount() || 1500;
    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('จำนวนเงิน:', 20, 260);

    ctx.fillStyle = '#138f2d';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(`฿${totalAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`, 20, 305);

    // ข้อมูลอ้างอิงและวันที่
    ctx.fillStyle = '#64748b';
    ctx.font = '13px sans-serif';
    ctx.fillText(`เลขอ้างอิง: ${uniqueRef}`, 20, 355);
    ctx.fillText(`วัน-เวลาที่ทำรายการ: ${new Date().toLocaleString('th-TH')}`, 20, 385);
    ctx.fillText('ค่าธรรมเนียม: 0.00 บาท', 20, 415);

    // ตราประทับ
    ctx.strokeStyle = '#138f2d';
    ctx.lineWidth = 2;
    ctx.strokeRect(20, 450, 220, 46);
    ctx.fillStyle = '#138f2d';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('✓ บันทึกสลิปสำเร็จ', 38, 480);

    attachedSlipBase64 = canvas.toDataURL('image/jpeg', 0.85);

    // แสดง Preview สลิปจำลอง
    const previewImg = document.getElementById('bookingSlipPreviewImg');
    const fileNameEl = document.getElementById('bookingSlipFileName');
    const previewContainer = document.getElementById('bookingSlipPreviewContainer');
    const uploadZone = document.getElementById('bookingSlipUploadZone');

    if (previewImg) previewImg.src = attachedSlipBase64;
    if (fileNameEl) fileNameEl.textContent = `สลิปจำลอง_KBANK (${uniqueRef}.jpg)`;
    if (previewContainer) previewContainer.style.display = 'block';
    if (uploadZone) uploadZone.style.borderColor = '#10b981';

    if (statusText) statusText.textContent = `✅ แนบสลิปทดสอบเรียบร้อย (Ref: ${uniqueRef})`;
    validateFormReadiness();
  };

  function validateFormReadiness() {
    const btn = document.getElementById('btnSubmitBooking');
    const notice = document.getElementById('bookingValidationNotice');
    const nameInput = document.getElementById('bookingCustName');
    const phoneInput = document.getElementById('bookingCustPhone');
    const bankRefInput = document.getElementById('bookingBankRefInput');
    const uploadZone = document.getElementById('bookingSlipUploadZone');

    const name = nameInput?.value.trim();
    const phone = phoneInput?.value.trim();
    const bankRef = bankRefInput?.value.trim();
    const total = getBookingTotalAmount();
    const count = getBookingTotalTickets();
    const isSystemC = (currentPaymentConfig && currentPaymentConfig.mode === 'system_c');

    // ล้างเส้นขอบสีแดงเมื่อผู้ใช้กรอกข้อมูลแล้ว
    if (name && nameInput) nameInput.style.borderColor = '';
    if (phone && phoneInput) phoneInput.style.borderColor = '';
    if (bankRef && bankRefInput) bankRefInput.style.borderColor = '';
    if (attachedSlipBase64 && uploadZone) uploadZone.style.borderColor = '#10b981';

    const hasSlip = Boolean(attachedSlipBase64);
    const isReady = (count > 0 && total > 0 && Boolean(name) && Boolean(phone));

    if (btn) {
      if (hasSlip) {
        btn.innerHTML = '⚡ ยืนยันและรับตั๋ว QR ทันที (ตรวจพบสลิปแนบ)';
        btn.style.background = 'linear-gradient(135deg, #059669 0%, #10b981 100%)';
        btn.style.boxShadow = '0 4px 22px rgba(16, 185, 129, 0.7)';
        btn.style.opacity = '1';
      } else {
        btn.innerHTML = '⚡ ยืนยันการจองและรับตั๋ว e-Ticket ทันที';
        btn.style.background = 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)';
        btn.style.boxShadow = isReady ? '0 4px 18px rgba(56, 189, 248, 0.5)' : '0 4px 14px rgba(56, 189, 248, 0.25)';
        btn.style.opacity = isReady ? '1' : '0.9';
      }
    }

    if (notice) {
      if (isReady) {
        if (hasSlip) {
          notice.innerHTML = '<span style="color: #34d399; font-weight: 700;">✅ แนบรูปสลิปแล้ว กดยืนยันเพื่อรับตั๋ว QR Code และใบเสร็จทันทีใน 1.5 วินาที</span>';
        } else {
          notice.innerHTML = '<span style="color: #38bdf8; font-weight: 700;">✅ ข้อมูลครบถ้วน (แนบรูปสลิปเพื่อรับตั๋วทันที หรือกดยืนยันเพื่อตรวจจับเงินเข้าอัตโนมัติ)</span>';
        }
      } else {
        const missing = [];
        if (count === 0) missing.push('เลือกประเภทบัตร');
        if (!name) missing.push('ชื่อ-นามสกุลผู้ซื้อ');
        if (!phone) missing.push('เบอร์โทรศัพท์');
        notice.innerHTML = `<span style="color: #fbbf24; font-size: 0.82rem;">⚠️ รอข้อมูล: ${missing.join(', ')}</span>`;
      }
    }
  }

  // ==========================================================================
  // THAI BAHT CURRENCY TEXT CONVERTER (ACCORDING TO THAI ACCOUNTING STANDARDS)
  // ==========================================================================
  function convertNumberToThaiBaht(num) {
    if (isNaN(num)) return '-';
    num = Math.round(num * 100) / 100;
    const parts = num.toFixed(2).split('.');
    const integerPart = parts[0];
    const decimalPart = parts[1];

    const thaiNumbers = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
    const thaiDigits = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน'];

    function readGroup(str) {
      let result = '';
      const len = str.length;
      for (let i = 0; i < len; i++) {
        const digit = parseInt(str.charAt(i), 10);
        const pos = len - i - 1;
        if (digit !== 0) {
          if (pos === 0 && digit === 1 && len > 1 && str.charAt(i - 1) !== '0') {
            result += 'เอ็ด';
          } else if (pos === 1 && digit === 2) {
            result += 'ยี่สิบ';
          } else if (pos === 1 && digit === 1) {
            result += 'สิบ';
          } else {
            result += thaiNumbers[digit] + (pos === 1 ? '' : thaiDigits[pos]);
          }
        }
      }
      return result;
    }

    let bahtText = '';
    if (parseInt(integerPart, 10) === 0) {
      bahtText = 'ศูนย์บาท';
    } else {
      let intStr = integerPart;
      if (intStr.length > 6) {
        const milPart = intStr.substring(0, intStr.length - 6);
        intStr = intStr.substring(intStr.length - 6);
        bahtText += readGroup(milPart) + 'ล้าน';
      }
      bahtText += readGroup(intStr) + 'บาท';
    }

    if (decimalPart === '00') {
      bahtText += 'ถ้วน';
    } else {
      const satang = parseInt(decimalPart, 10);
      let satangText = '';
      const tenSat = Math.floor(satang / 10);
      const unitSat = satang % 10;
      if (tenSat > 0) {
        if (tenSat === 1) satangText += 'สิบ';
        else if (tenSat === 2) satangText += 'ยี่สิบ';
        else satangText += thaiNumbers[tenSat] + 'สิบ';
      }
      if (unitSat > 0) {
        if (unitSat === 1 && tenSat > 0) satangText += 'เอ็ด';
        else satangText += thaiNumbers[unitSat];
      }
      bahtText += satangText + 'สตางค์';
    }
    return bahtText;
  }

  // ==========================================================================
  // ORDER SUBMISSION & 3-MINUTE SYNCHRONOUS VERIFICATION
  // ==========================================================================
  window.submitBookingOrder = function () {
    const total = getBookingTotalAmount();
    const count = getBookingTotalTickets();
    const custNameInput = document.getElementById('bookingCustName');
    const custPhoneInput = document.getElementById('bookingCustPhone');
    const bankRefInput = document.getElementById('bookingBankRefInput');
    const uploadZone = document.getElementById('bookingSlipUploadZone');
    const notice = document.getElementById('bookingValidationNotice');

    const custName = custNameInput?.value.trim();
    const custPhone = custPhoneInput?.value.trim();
    const bankRef = bankRefInput?.value.trim();

    if (count === 0 || total <= 0) {
      alert('⚠️ กรุณาเลือกประเภทและจำนวนบัตรคอนเสิร์ตอย่างน้อย 1 ใบก่อนนะคะ');
      const tierContainer = document.getElementById('bookingTierListContainer');
      if (tierContainer) tierContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (notice) notice.innerHTML = '<span style="color: #ef4444; font-weight: 700;">❌ กรุณาเลือกจำนวนบัตรคอนเสิร์ต</span>';
      return;
    }

    if (!custName) {
      alert('⚠️ กรุณากรอกชื่อ-นามสกุลของผู้สั่งซื้อบัตรก่อนนะคะ');
      if (custNameInput) {
        custNameInput.style.borderColor = '#ef4444';
        custNameInput.focus();
      }
      if (notice) notice.innerHTML = '<span style="color: #ef4444; font-weight: 700;">❌ กรุณากรอกชื่อ-นามสกุลผู้สั่งซื้อ</span>';
      return;
    }

    if (!custPhone) {
      alert('⚠️ กรุณากรอกเบอร์โทรศัพท์มือถือของผู้สั่งซื้อบัตรก่อนนะคะ (เช่น 081-987-6543)');
      if (custPhoneInput) {
        custPhoneInput.style.borderColor = '#ef4444';
        custPhoneInput.focus();
      }
      if (notice) notice.innerHTML = '<span style="color: #ef4444; font-weight: 700;">❌ กรุณากรอกเบอร์โทรศัพท์มือถือ</span>';
      return;
    }

    const hasSlip = Boolean(attachedSlipBase64);
    const isSystemC = (currentPaymentConfig && currentPaymentConfig.mode === 'system_c');

    // รวบรวมรายชื่อผู้เข้าชม
    const attendeeInputs = document.querySelectorAll('.booking-attendee-input');
    const attendeeNamesByTier = {};

    attendeeInputs.forEach(input => {
      const tierId = input.getAttribute('data-tier');
      const val = input.value.trim() || custName;
      if (!attendeeNamesByTier[tierId]) attendeeNamesByTier[tierId] = [];
      attendeeNamesByTier[tierId].push(val);
    });

    const items = [];
    const tiers = EventPayDB.getAll('ticket_tiers');
    tiers.forEach(tier => {
      const qty = bookingQuantities[tier.tier_id] || 0;
      if (qty > 0) {
        const names = attendeeNamesByTier[tier.tier_id] || [];
        if (names.length === 0) names.push(custName);
        while (names.length < qty) names.push(custName);

        items.push({
          tier_id: tier.tier_id,
          quantity: qty,
          attendee_names: names
        });
      }
    });

    const effectiveTotal = isSystemC ? getEffectiveTotal(total) : total;
    const finalBankRef = bankRef || (hasSlip ? ('SLIP-' + Date.now().toString().slice(-8)) : ('AUTO-PROMPTPAY-' + Date.now().toString().slice(-6)));
    const finalSlipUrl = attachedSlipBase64 || '';

    // [STRICT FINANCIAL SHIELD - VERIFY SLIP AMOUNT BEFORE TICKETING]:
    // หากมีสลิปแนบ ให้ตรวจยอดเงินโอนจริงเทียบกับยอดจองตั๋ว
    if (hasSlip) {
      const slipAmountInput = document.getElementById('bookingSlipAmountInput');
      const slipAmt = slipAmountInput ? parseFloat(slipAmountInput.value || 0) : effectiveTotal;
      const orderAmt = parseFloat(effectiveTotal);

      if (slipAmt < orderAmt - 0.01) {
        const diff = (orderAmt - slipAmt).toFixed(2);
        const alertBox = document.getElementById('bookingAmountMismatchAlert');
        const alertText = document.getElementById('bookingAmountMismatchText');
        if (alertBox && alertText) {
          alertText.innerHTML = `
            <strong>ยอดที่ต้องชำระตามจำนวนบัตร:</strong> ฿${orderAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท<br>
            <strong>ยอดเงินที่ระบุในสลิป:</strong> ฿${slipAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท<br>
            <strong style="color: #fca5a5;">⚠️ ยอดเงินโอนขาดไป: ฿${parseFloat(diff).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท</strong><br>
            <span style="font-size: 0.82rem; color: #fde047; margin-top: 6px; display: inline-block;">
              👉 กรุณาโอนยอดเงินให้ถูกต้องครบถ้วนตามราคาบัตร แล้วแนบรูปภาพสลิปใหม่อีกครั้งค่ะ ระบบไม่สามารถออกตั๋วให้ได้ถ้ายอดเงินไม่ครบถ้วน
            </span>
          `;
          alertBox.style.display = 'block';
          alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (typeof AudioAlertEngine !== 'undefined' && AudioAlertEngine.playAlarm) {
          AudioAlertEngine.playAlarm();
        } else if (typeof AudioAlertEngine !== 'undefined' && AudioAlertEngine.playBeep) {
          AudioAlertEngine.playBeep('error');
        }
        alert(`🚨 แจ้งเตือนความปลอดภัยทางการเงิน!\nยอดเงินโอนไม่ตรงกับยอดจองตั๋วคอนเสิร์ต\n\nยอดที่ต้องชำระ: ฿${orderAmt.toFixed(2)} บาท\nยอดเงินในสลิป: ฿${slipAmt.toFixed(2)} บาท (ขาดไป ฿${diff} บาท)\n\nกรุณาโอนยอดเงินให้ถูกต้องครบถ้วน แล้วแนบรูปภาพสลิปที่ถูกต้องใหม่อีกครั้งค่ะ`);
        return; // ห้ามออกตั๋วเด็ดขาด!
      }
    }

    // หากมีสลิปและยอดเงินครบถ้วน ให้ BotAdmin ออกตั๋ว QR Code และใบเสร็จทันทีใน 1.5 วินาที!
    const requiresVerification = !hasSlip;

    const orderData = {
      customer_name: custName,
      customer_phone: custPhone,
      payment_method: 'TRANSFER',
      shift_id: 'SHIFT-ONLINE-SELF',
      bank_ref: finalBankRef,
      slip_url: finalSlipUrl,
      requires_verification: requiresVerification,
      items: items
    };

    try {
      const result = EventPayDB.createOrder(orderData, 'ONLINE_CUSTOMER');
      currentWaitingOrderId = result.order.order_id;

      // [UNIVERSAL CLOUD QUAD-SYNC]: ซิงก์ขึ้น Firebase Firestore Cloud แบบ Real-time ทันที
      try {
        if (typeof EventPayFirebase !== 'undefined' && typeof EventPayFirebase.syncOrderToCloud === 'function') {
          const allTickets = (typeof EventPayDB !== 'undefined' && EventPayDB.getAll)
            ? EventPayDB.getAll('tickets', t => t.order_id === result.order.order_id)
            : [];
          EventPayFirebase.syncOrderToCloud(result.order, allTickets);
        }
      } catch (eCloud) {
        console.warn('[Booking] Cloud order sync non-blocking warning:', eCloud);
      }

      // [INSERT ACTIVE MODERN LOGIC]: ซิงก์คำสั่งซื้อขึ้น Master Server ทันที เพื่อให้ตู้ Kiosk และ Bot ทำงานได้ข้ามเครื่อง 100%
      try {
        const apiUrl = (typeof EventPayDB !== 'undefined' && typeof EventPayDB.getApiUrl === 'function')
          ? EventPayDB.getApiUrl('/api/orders/create')
          : ((typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://localhost:8080/api/orders/create' : '/api/orders/create');
        fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderData: { ...orderData, order_id: result.order.order_id }, cashierId: 'ONLINE_CUSTOMER' })
        }).catch(e => console.warn('[Booking] Server order sync non-blocking error:', e));
      } catch (eSync) {}

      // [BOTADMIN INSTANT TICKETING]: หากมีสลิป ออกตั๋ว e-Ticket QR Code และใบเสร็จทันทีใน 1.5 วินาที!
      if (hasSlip) {
        const stepForm = document.getElementById('bookingStepContainer');
        if (stepForm) stepForm.style.opacity = '0.5';

        const noticeEl = document.getElementById('bookingValidationNotice');
        if (noticeEl) {
          noticeEl.innerHTML = '<span style="color: #10b981; font-weight: 700; font-size: 1.1rem; animation: pulse 1s infinite;">⚡ BotAdmin กำลังออกตั๋ว QR Code และใบเสร็จทางการ...</span>';
        }

        setTimeout(() => {
          handlePaymentSuccessAuto(result.order.order_id);
        }, 1200);
      } else if (isSystemC) {
        // ไม่มีสลิปแนบ -> รอระบบตรวจจับเงินเข้าอัตโนมัติ (Zero-Slip / Bank Open API)
        if (effectiveTotal !== total) {
          EventPayDB.update('orders', result.order.order_id, { total_amount: effectiveTotal });
          const p = EventPayDB.getAll('payments', p => p.order_id === result.order.order_id)[0];
          if (p) EventPayDB.update('payments', p.payment_id, { amount: effectiveTotal });
        }

        startZeroSlipCountdown(180);

        const btn = document.getElementById('btnSubmitBooking');
        if (btn) {
          btn.innerHTML = '🟢 ระบบกำลังรอตรวจจับเงินเข้าอัตโนมัติ...';
          btn.disabled = true;
        }
        if (notice) {
          notice.innerHTML = '<span style="color: #34d399; font-weight: 700;">📡 บันทึกคำสั่งซื้อแล้ว ระบบกำลังรอตรวจจับเงินเข้าจากบัญชีธนาคาร</span>';
        }

        if (systemCPollingInterval) clearInterval(systemCPollingInterval);
        systemCPollingInterval = setInterval(() => {
          const freshOrder = EventPayDB.get('orders', result.order.order_id);
          if (freshOrder && freshOrder.payment_status === 'PAID') {
            handlePaymentSuccessAuto(result.order.order_id);
          }
        }, 1500);
      } else {
        // เริ่มต้นกระบวนการรอตรวจสอบ 3 นาที (Synchronous Verification)
        startWaitingVerification(result);
      }

    } catch (err) {
      console.error('[Booking] Order submission error:', err);
      alert('เกิดข้อผิดพลาดในการทำรายการ: ' + err.message);
    }
  };

  function startWaitingVerification(result) {
    const formSection = document.getElementById('bookingFormSection');
    const waitingSection = document.getElementById('bookingWaitingSection');
    const successSection = document.getElementById('bookingSuccessSection');

    if (formSection) formSection.style.display = 'none';
    if (successSection) successSection.style.display = 'none';
    if (waitingSection) waitingSection.style.display = 'block';

    const order = result.order;
    const payment = result.payment;

    const waitOrderId = document.getElementById('waitOrderId');
    const waitCustName = document.getElementById('waitCustName');
    const waitCustPhone = document.getElementById('waitCustPhone');
    const waitTotalAmount = document.getElementById('waitTotalAmount');
    const waitBankRef = document.getElementById('waitBankRef');
    const waitSlipImgWrap = document.getElementById('waitSlipImgWrap');
    const waitSlipImg = document.getElementById('waitSlipImg');

    if (waitOrderId) waitOrderId.textContent = order.order_id;
    if (waitCustName) waitCustName.textContent = order.customer_name;
    if (waitCustPhone) waitCustPhone.textContent = order.customer_phone;
    if (waitTotalAmount) waitTotalAmount.textContent = order.total_amount.toLocaleString('th-TH', { minimumFractionDigits: 2 });
    if (waitBankRef) waitBankRef.textContent = payment.bank_ref || order.bank_ref || '-';

    if (payment.slip_url && waitSlipImg && waitSlipImgWrap) {
      waitSlipImg.src = payment.slip_url;
      waitSlipImgWrap.style.display = 'block';
    }

    // นับถอยหลัง 3 นาที (180 วินาที)
    let remainingSeconds = 180;
    const countdownEl = document.getElementById('waitingCountdownTimer');

    if (waitingCountdownInterval) clearInterval(waitingCountdownInterval);
    waitingCountdownInterval = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds <= 0) {
        clearInterval(waitingCountdownInterval);
        if (countdownEl) countdownEl.textContent = '00:00';
      } else {
        const mins = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
        const secs = String(remainingSeconds % 60).padStart(2, '0');
        if (countdownEl) countdownEl.textContent = `${mins}:${secs}`;
      }
    }, 1000);

    // Auto-polling ตรวจสอบสถานะคำสั่งซื้อจาก DB ทุก 2 วินาที
    if (waitingPollInterval) clearInterval(waitingPollInterval);
    waitingPollInterval = setInterval(() => {
      if (!currentWaitingOrderId || typeof EventPayDB === 'undefined') return;

      const updatedOrder = EventPayDB.get('orders', currentWaitingOrderId);
      if (!updatedOrder) return;

      if (updatedOrder.payment_status === 'PAID') {
        // ฝ่ายบัญชีกดยืนยันยอดเงินเข้าแล้ว!
        clearInterval(waitingPollInterval);
        clearInterval(waitingCountdownInterval);

        if (audioAlert) audioAlert.playSuccessChime();

        const payments = EventPayDB.getAll('payments', p => p.order_id === currentWaitingOrderId);
        const tickets = EventPayDB.getAll('tickets', t => t.order_id === currentWaitingOrderId);

        if (waitingSection) waitingSection.style.display = 'none';
        if (successSection) successSection.style.display = 'block';

        displayBookingSuccess({
          order: updatedOrder,
          payment: payments[0] || payment,
          tickets: tickets
        });

      } else if (updatedOrder.payment_status === 'AMOUNT_MISMATCH') {
        // [RULE 4]: ตรวจพบยอดเงินโอนไม่ตรง หรือน้อยกว่ายอดจอง ระงับการออกตั๋วเด็ดขาด
        clearInterval(waitingPollInterval);
        clearInterval(waitingCountdownInterval);

        if (audioAlert) audioAlert.playAlertSiren();

        const waitBadge = document.getElementById('waitBadge');
        if (waitBadge) {
          waitBadge.className = 'ep-badge ep-badge-danger';
          waitBadge.style.animation = 'none';
          waitBadge.textContent = '⚠️ ยอดเงินไม่ถูกต้อง (ยอดโอนน้อยกว่ายอดจอง)';
        }

        alert(`🚨 แจ้งเตือนความปลอดภัยทางการเงิน:\nยอดเงินที่โอนเข้ามา ไม่ตรงกับยอดรวมของคำสั่งซื้อ (ยอดโอนน้อยกว่ายอดที่ต้องชำระ ฿${(updatedOrder.total_amount || 0).toLocaleString('th-TH')})\nระบบระงับการออกตั๋วอัตโนมัติ กรุณาติดต่อฝ่ายบัญชีเพื่อตรวจสอบสเตทเมนต์`);

      } else if (updatedOrder.payment_status === 'VOID') {
        // ฝ่ายบัญชีตรวจพบสลิปปลอม หรือระงับสิทธิ์
        clearInterval(waitingPollInterval);
        clearInterval(waitingCountdownInterval);

        if (audioAlert) audioAlert.playAlertSiren();

        const waitBadge = document.getElementById('waitBadge');
        if (waitBadge) {
          waitBadge.className = 'ep-badge ep-badge-danger';
          waitBadge.style.animation = 'none';
          waitBadge.textContent = '🔴 ปฏิเสธ/ระงับสิทธิ์ (สลิปไม่ถูกต้อง)';
        }

        alert('🚨 แจ้งเตือนจากฝ่ายการเงิน:\nการตรวจสอบไม่ผ่าน เนื่องจากสลิปไม่ตรงกับยอดเงินในสเตทเมนต์ธนาคาร หรือตรวจพบสลิปซ้ำ\nหากมีข้อสงสัยโปรดติดต่อ 086-366-4434, 095-761-4224');
      }
    }, 2000);

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function displayBookingSuccess(result) {
    lastBookingResult = result;
    const formSection = document.getElementById('bookingFormSection');
    const waitingSection = document.getElementById('bookingWaitingSection');
    const successSection = document.getElementById('bookingSuccessSection');

    if (formSection) formSection.style.display = 'none';
    if (waitingSection) waitingSection.style.display = 'none';
    if (successSection) successSection.style.display = 'block';

    const order = result.order;
    const payment = result.payment;
    const tickets = result.tickets;

    // 1. อัปเดตข้อมูลใบเสร็จรับเงินทางการ (Official Receipt)
    const rcpNumber = document.getElementById('rcpNumber');
    const rcpDate = document.getElementById('rcpDate');
    const rcpCustName = document.getElementById('rcpCustName');
    const rcpCustPhone = document.getElementById('rcpCustPhone');
    const rcpBankRef = document.getElementById('rcpBankRef');
    const rcpGrandTotal = document.getElementById('rcpGrandTotal');
    const rcpTotalThaiText = document.getElementById('rcpTotalThaiText');
    const rcpItemsTableBody = document.getElementById('rcpItemsTableBody');

    const formattedRcpId = `RCP-${new Date(order.created_at || Date.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${order.order_id.slice(-4)}`;
    if (rcpNumber) rcpNumber.textContent = formattedRcpId;
    if (rcpDate) rcpDate.textContent = new Date(order.created_at || Date.now()).toLocaleString('th-TH');
    if (rcpCustName) rcpCustName.textContent = order.customer_name;
    if (rcpCustPhone) rcpCustPhone.textContent = order.customer_phone;
    if (rcpBankRef) rcpBankRef.textContent = payment.bank_ref || order.bank_ref || '-';
    if (rcpGrandTotal) rcpGrandTotal.textContent = `฿${order.total_amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    if (rcpTotalThaiText) rcpTotalThaiText.textContent = convertNumberToThaiBaht(order.total_amount);

    // สรุปรายการในตารางใบเสร็จ
    if (rcpItemsTableBody) {
      rcpItemsTableBody.innerHTML = '';
      const tiersMap = {};
      tickets.forEach(t => {
        if (!tiersMap[t.tier_id]) {
          tiersMap[t.tier_id] = { name: t.tier_name, count: 0 };
        }
        tiersMap[t.tier_id].count++;
      });

      let rowIdx = 1;
      const allTiers = EventPayDB.getAll('ticket_tiers');
      Object.keys(tiersMap).forEach(tierId => {
        const item = tiersMap[tierId];
        const tierObj = allTiers.find(x => x.tier_id === tierId);
        const price = tierObj ? tierObj.price : 0;
        const lineTotal = price * item.count;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="text-align: center; color: #64748b;">${rowIdx++}</td>
          <td>
            <strong>${escapeHtml(item.name)}</strong>
            <div style="font-size: 0.78rem; color: #64748b;">บัตรเข้าชมคอนเสิร์ต (e-Ticket)</div>
          </td>
          <td style="text-align: center; font-weight: 700;">${item.count} ใบ</td>
          <td style="text-align: right;">฿${price.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
          <td style="text-align: right; font-weight: 700;">฿${lineTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        `;
        rcpItemsTableBody.appendChild(tr);
      });
    }

    // 2. แสดงบัตรคอนเสิร์ต e-Ticket พร้อม QR Code (1:1 Ratio ตามจำนวนใบที่สั่งซื้อ)
    const ticketsArea = document.getElementById('bookingIssuedTicketsArea');
    if (ticketsArea) {
      ticketsArea.innerHTML = '';
      tickets.forEach((ticket, idx) => {
        const card = document.createElement('div');
        card.className = 'ep-ticket-pass';
        card.style.maxWidth = '460px';
        card.style.width = '100%';
        card.style.margin = '0 auto 10px auto';
        card.style.boxShadow = '0 8px 24px rgba(0,0,0,0.6)';

        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:6px; margin-bottom:8px;">
            <span style="font-size:0.75rem; color:var(--accent-gold); font-weight:700;">OFFICIAL E-TICKET #${idx + 1}</span>
            <span style="font-size:0.75rem; color:${ticket.is_void ? '#ef4444' : 'var(--accent-green)'}; font-weight:800;">
              ● ${ticket.is_void ? '⚠️ ระงับสิทธิ์' : 'พร้อมสแกนเข้างาน'}
            </span>
          </div>
          <h3 style="color: var(--accent-gold); font-size: 1.25rem; margin-bottom: 4px;">${escapeHtml(ticket.tier_name)}</h3>
          <p style="font-size: 0.9rem; color: #fff; margin-bottom:10px;">ผู้ถือบัตร: <strong>${escapeHtml(ticket.attendee_name)}</strong></p>
          
          <!-- SINGLE-USE TICKET BADGE -->
          <div class="ep-single-use-badge">
            <div class="ep-single-use-badge-text">
              <span>🛡️</span> 1 คิวอาร์โค้ด ใช้ได้ 1 ท่านเท่านั้น
            </div>
          </div>

          <div class="ep-ticket-qr-wrap" id="online_qr_${ticket.ticket_id}" style="width:180px; height:180px; margin:0 auto 10px auto; background:#fff; padding:10px; border-radius:8px; display:flex; align-items:center; justify-content:center;">
            <!-- QR rendered -->
          </div>

          <div style="font-family: monospace; font-size: 0.85rem; color: var(--accent-cyan); letter-spacing: 1px; margin-bottom:10px; word-break: break-all;">
            ${escapeHtml(ticket.qr_code_hash)}
          </div>

          <div class="ep-ticket-meta" style="text-align:left; font-size:0.8rem; background:#070d1a; padding:10px; border-radius:6px; display:grid; grid-template-columns: 1fr 1fr; gap: 4px;">
            <div>รหัสบัตร: <strong style="color:#fff;">${ticket.ticket_id}</strong></div>
            <div>คำสั่งซื้อ: <strong style="color:#fff;">${ticket.order_id}</strong></div>
            <div>สถานะ: <strong style="color: var(--accent-green);">${ticket.is_void ? 'ระงับตรวจสอบ' : 'สิทธิ์สมบูรณ์'}</strong></div>
            <div>ริสต์แบนด์: <strong style="color:var(--text-muted);">${ticket.wristband_id || 'รับสายรัดข้อมือหน้างาน'}</strong></div>
          </div>
        `;
        ticketsArea.appendChild(card);

        // วาดภาพ QR Code แบบออฟไลน์
        setTimeout(() => {
          const qrBox = document.getElementById(`online_qr_${ticket.ticket_id}`);
          if (qrBox && typeof QRCode !== 'undefined') {
            new QRCode(qrBox, {
              text: ticket.qr_code_hash,
              width: 160,
              height: 160,
              colorDark: '#000000',
              colorLight: '#ffffff'
            });
          }
        }, 50);
      });
    }

    // เลื่อนหน้าจอขึ้นมาด้านบนสุด
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ==========================================================================
  // TICKET LOOKUP & E-TICKET RETRIEVAL (DUAL-STATE: PENDING VS APPROVED)
  // ==========================================================================
  let lookupAutoSyncInterval = null;
  let lastLookupQuery = '';

  function startLookupAutoSync() {
    if (lookupAutoSyncInterval) clearInterval(lookupAutoSyncInterval);
    lookupAutoSyncInterval = setInterval(() => {
      const modal = document.getElementById('modalTicketLookup');
      if (!modal || !modal.classList.contains('show')) {
        clearInterval(lookupAutoSyncInterval);
        lookupAutoSyncInterval = null;
        return;
      }
      if (!lastLookupQuery) return;

      const pendingCards = document.querySelectorAll('.ep-ticket-pending-card');
      if (pendingCards.length > 0) {
        const allOrders = (typeof EventPayDB !== 'undefined' ? EventPayDB.getAll('orders') : []) || [];
        const hasApprovedOrder = allOrders.some(o => o.payment_status === 'PAID');
        if (hasApprovedOrder) {
          window.performTicketLookup(null, true);
        }
      }
    }, 2000);
  }

  window.openTicketLookupModal = function () {
    const modal = document.getElementById('modalTicketLookup');
    if (modal) {
      modal.classList.add('show');
      const input = document.getElementById('lookupQueryInput');
      if (input) {
        input.value = '';
        input.focus();
      }
      const container = document.getElementById('lookupResultsContainer');
      if (container) container.innerHTML = '';
    }
  };

  window.closeTicketLookupModal = function () {
    const modal = document.getElementById('modalTicketLookup');
    if (modal) modal.classList.remove('show');
    if (lookupAutoSyncInterval) {
      clearInterval(lookupAutoSyncInterval);
      lookupAutoSyncInterval = null;
    }
  };

  window.downloadOrPrintTickets = function () {
    const allApproved = document.querySelectorAll('#lookupResultsContainer [id^="lookup_qr_"]');
    if (!allApproved || allApproved.length === 0) {
      alert('ℹ️ บัตรของท่านกำลังอยู่ในขั้นตอนตรวจสอบยอดเงินเข้าจากธนาคาร เมื่อได้รับการอนุมัติแล้ว ระบบจะสร้างคิวอาร์โค้ดให้ท่านดาวน์โหลดหรือพิมพ์ได้ทันทีค่ะ');
      return;
    }

    const approvedTickets = [];
    let parentOrder = null;
    if (window._currentLookupEvaluated && window._currentLookupEvaluated.length > 0) {
      window._currentLookupEvaluated.forEach(item => {
        if (item.isApproved) {
          approvedTickets.push(item.ticket);
          if (!parentOrder && item.parentOrder) parentOrder = item.parentOrder;
        }
      });
    }

    if (approvedTickets.length === 0 && typeof EventPayDB !== 'undefined') {
      allApproved.forEach(el => {
        const tid = el.id.replace('lookup_qr_', '');
        const t = EventPayDB.get('tickets', tid);
        if (t) {
          approvedTickets.push(t);
          if (!parentOrder && t.order_id) parentOrder = EventPayDB.get('orders', t.order_id);
        }
      });
    }

    if (approvedTickets.length > 0 && typeof executeBookingThermalPrint === 'function') {
      executeBookingThermalPrint(parentOrder || {}, approvedTickets, 'TICKETS_ONLY');
    } else {
      document.body.classList.add('print-lookup-tickets');
      window.print();
      setTimeout(() => {
        document.body.classList.remove('print-lookup-tickets');
      }, 1000);
    }
  };

  window.downloadSingleTicketQR = function (ticketId) {
    const qrBox = document.getElementById(`lookup_qr_${ticketId}`);
    if (!qrBox) return;
    const canvas = qrBox.querySelector('canvas');
    const img = qrBox.querySelector('img');
    const src = canvas ? canvas.toDataURL('image/png') : (img ? img.src : null);
    if (src) {
      const a = document.createElement('a');
      a.href = src;
      a.download = `EventPay_QR_${ticketId}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  window.performTicketLookup = function (event, silent = false) {
    if (event) event.preventDefault();
    const queryInput = document.getElementById('lookupQueryInput');
    const query = queryInput ? queryInput.value.trim() : lastLookupQuery;
    const container = document.getElementById('lookupResultsContainer');
    if (!query || !container) return;

    lastLookupQuery = query;

    if (!silent) {
      container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">กำลังค้นหาบัตร...</div>';
    }

    // Normalize phone number (digits only or raw)
    const cleanDigits = query.replace(/[^0-9]/g, '');
    const allTickets = (typeof EventPayDB !== 'undefined' ? EventPayDB.getAll('tickets') : []) || [];
    const allOrders = (typeof EventPayDB !== 'undefined' ? EventPayDB.getAll('orders') : []) || [];

    // Find matching tickets
    const matchedTickets = allTickets.filter(t => {
      const matchTktId = t.ticket_id && t.ticket_id.toLowerCase().includes(query.toLowerCase());
      const matchOrderId = t.order_id && t.order_id.toLowerCase().includes(query.toLowerCase());
      const matchName = t.attendee_name && t.attendee_name.toLowerCase().includes(query.toLowerCase());
      
      let matchPhone = false;
      if (t.attendee_phone) {
        const tktPhoneDigits = t.attendee_phone.replace(/[^0-9]/g, '');
        if (cleanDigits && tktPhoneDigits.includes(cleanDigits)) matchPhone = true;
      }

      // Check linked order phone
      if (!matchPhone && t.order_id) {
        const ord = allOrders.find(o => o.order_id === t.order_id);
        if (ord && ord.customer_phone) {
          const ordPhoneDigits = ord.customer_phone.replace(/[^0-9]/g, '');
          if (cleanDigits && ordPhoneDigits.includes(cleanDigits)) matchPhone = true;
        }
      }

      return matchTktId || matchOrderId || matchName || matchPhone;
    });

    if (matchedTickets.length === 0) {
      // ตรวจสอบกรณีพบคำสั่งซื้อในระบบที่ยังรอตรวจสอบสเตทเมนต์
      const matchedOrder = allOrders.find(o => {
        const matchOrdId = o.order_id && o.order_id.toLowerCase().includes(query.toLowerCase());
        let matchOrdPhone = false;
        if (o.customer_phone) {
          const ordPhoneDigits = o.customer_phone.replace(/[^0-9]/g, '');
          if (cleanDigits && ordPhoneDigits.includes(cleanDigits)) matchOrdPhone = true;
        }
        return matchOrdId || matchOrdPhone;
      });

      if (matchedOrder && matchedOrder.payment_status === 'PENDING_VERIFICATION') {
        container.innerHTML = `
          <div style="text-align: center; padding: 24px 14px; background: rgba(245, 158, 11, 0.1); border: 1.5px dashed #f59e0b; border-radius: 8px;">
            <div style="font-size: 2.2rem; margin-bottom: 6px; animation: spinHourglass 3s linear infinite;">⏳</div>
            <div style="color: #fbbf24; font-weight: 800; font-size: 1.05rem; margin-bottom: 6px;">
              พบคำสั่งซื้อ ${escapeHtml(matchedOrder.order_id)} ของท่าน
            </div>
            <div style="font-size: 0.88rem; color: #fef08a; font-weight: 700; margin-bottom: 8px;">
              (อยู่ระหว่างรอธนาคารตรวจสอบยอดเงินโอน และรอระบบ Bot เจนตั๋วคิวอาร์โค้ดให้อัตโนมัติ ไม่เกิน 3 นาที)
            </div>
            <div style="font-size: 0.8rem; color: #94a3b8;">
              ⚠️ เตือนลูกค้าให้รอธนาคารตรวจสลิป และรอจนกว่า Bot เจนให้เมื่อธนาคารแจ้งได้รับเงิน
            </div>
          </div>
        `;
        startLookupAutoSync();
        return;
      }

      container.innerHTML = `
        <div style="text-align: center; padding: 24px 10px; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px;">
          <div style="font-size: 1.8rem; margin-bottom: 6px;">🔍</div>
          <div style="color: #f87171; font-weight: 700; margin-bottom: 4px;">ไม่พบบัตรที่ตรงกับ "${escapeHtml(query)}"</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">โปรดตรวจสอบเบอร์โทรศัพท์ที่ใช้จอง หรือลองค้นหาด้วยรหัสคำสั่งซื้อ (เช่น ORD-20261017-001)</div>
        </div>
      `;
      return;
    }

    // Determine pending and approved cards
    const hadPendingBefore = document.querySelectorAll('.ep-ticket-pending-card').length > 0;

    // คำนวณสถานะความปลอดภัยของบัตรแต่ละใบอย่างละเอียดรอบคอบ (Strict Dual State Guard)
    const evaluatedTickets = matchedTickets.map(t => {
      const parentOrder = allOrders.find(o => o.order_id === t.order_id);
      const isPending = (parentOrder && parentOrder.payment_status === 'PENDING_VERIFICATION') || 
                        (t.is_void && parentOrder && parentOrder.payment_status !== 'VOID');
      const isVoid = (parentOrder && parentOrder.payment_status === 'VOID') || (t.is_void && !isPending);
      const isApproved = !isPending && !isVoid && ((parentOrder && parentOrder.payment_status === 'PAID') || (!t.is_void));
      return { ticket: t, parentOrder, isPending, isVoid, isApproved };
    });
    window._currentLookupEvaluated = evaluatedTickets;

    const pendingCount = evaluatedTickets.filter(x => x.isPending).length;
    const allPending = evaluatedTickets.length > 0 && pendingCount === evaluatedTickets.length;

    // [ข้อความตำแหน่งที่ 1]: ด้านบนของผลการค้นหา (Top Header Banner)
    let headerBannerHtml = '';
    if (allPending) {
      headerBannerHtml = `
        <div style="font-size: 0.88rem; color: #fbbf24; font-weight: 700; margin-bottom: 12px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 8px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 1.3rem; animation: spinHourglass 3s linear infinite;">⏳</span>
            <span>พบคำสั่งซื้อของท่าน (อยู่ระหว่างรอธนาคารตรวจสอบยอดเงินโอน และรอระบบ Bot เจนตั๋วคิวอาร์โค้ดให้อัตโนมัติ ไม่เกิน 3 นาที)</span>
          </div>
          <button type="button" class="ep-nav-btn" style="font-size: 0.78rem; padding: 6px 12px; background: #334155; color: #94a3b8; font-weight: 700; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; cursor: not-allowed; opacity: 0.7;" disabled title="รอธนาคารตรวจสอบและ Bot เจนตั๋วก่อนจึงจะดาวน์โหลดได้">
            ⏳ รออนุมัติก่อนดาวน์โหลด
          </button>
        </div>
      `;
    } else if (pendingCount > 0) {
      headerBannerHtml = `
        <div style="font-size: 0.88rem; color: #34d399; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <div>
            <span>🎉 พบบัตรคอนเสิร์ตจำนวน ${matchedTickets.length} ใบ</span>
            <span style="color: #fbbf24; font-size: 0.8rem; margin-left: 6px;">(รอตรวจสเตทเมนต์ ${pendingCount} ใบ):</span>
          </div>
          <button type="button" class="ep-nav-btn" style="font-size: 0.78rem; padding: 6px 12px; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #fff; font-weight: 800; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);" onclick="window.downloadOrPrintTickets()">
            Download/🖨️ พิมพ์ / แคปเจอร์ (เฉพาะใบที่อนุมัติ)
          </button>
        </div>
      `;
    } else {
      headerBannerHtml = `
        <div style="font-size: 0.88rem; color: #34d399; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <span>🎉 พบบัตรคอนเสิร์ตจำนวน ${matchedTickets.length} ใบ:</span>
          <button type="button" class="ep-nav-btn" style="font-size: 0.78rem; padding: 6px 12px; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #fff; font-weight: 800; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);" onclick="window.downloadOrPrintTickets()">
            Download/🖨️ พิมพ์ / แคปเจอร์
          </button>
        </div>
      `;
    }

    container.innerHTML = `
      ${headerBannerHtml}
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${evaluatedTickets.map(({ ticket: t, parentOrder, isPending, isVoid, isApproved }, idx) => {
          let statusBadgeHtml = '';
          if (isPending) {
            statusBadgeHtml = '<span style="font-size: 0.75rem; color: #f59e0b; font-weight: 800; background: rgba(245, 158, 11, 0.15); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.4);">● รอตรวจสเตทเมนต์</span>';
          } else if (isVoid) {
            statusBadgeHtml = '<span style="font-size: 0.75rem; color: #ef4444; font-weight: 800; background: rgba(239, 68, 68, 0.15); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.4);">● บัตรโมฆะ</span>';
          } else {
            const gateText = t.gate_status === 'ENTERED' ? 'เข้างานแล้ว' : 'อนุมัติ';
            statusBadgeHtml = `<span style="font-size: 0.75rem; color: #10b981; font-weight: 800; background: rgba(16, 185, 129, 0.15); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.4);">● ${gateText}</span>`;
          }

          // [ข้อความตำแหน่งที่ 2]: ในคิวอาร์โค้ด (QR Area)
          let centerAreaHtml = '';
          if (isPending) {
            centerAreaHtml = `
              <div class="ep-ticket-pending-card" style="width: 100%; max-width: 320px; min-height: 150px; margin: 12px auto; background: rgba(15, 23, 42, 0.85); border: 1.5px dashed #f59e0b; border-radius: 8px; padding: 16px 14px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-shadow: 0 0 15px rgba(245, 158, 11, 0.15);">
                <div style="font-size: 2.2rem; margin-bottom: 6px; animation: spinHourglass 3s linear infinite;">⏳</div>
                <div style="color: #fbbf24; font-weight: 800; font-size: 1rem; line-height: 1.4;">
                  ระบบรอสร้างคิวอาร์โค้ดบัตร<br>เมื่อธนาคารรับเงินแล้ว
                </div>
                <div style="font-size: 0.82rem; color: #fef08a; margin-top: 8px; font-weight: 600; line-height: 1.4;">
                  ⚠️ เตือนลูกค้าให้รอธนาคารตรวจสลิป และรอจนกว่า Bot เจนให้เมื่อธนาคารแจ้งได้รับเงิน
                </div>
                <div style="font-size: 0.74rem; color: #94a3b8; margin-top: 6px;">
                  (ระบบจะออกตั๋วคิวอาร์โค้ดให้อัตโนมัติทันทีที่ยอดเงินเข้าบัญชี ไม่เกิน 3 นาที)
                </div>
              </div>
            `;
          } else if (isVoid) {
            centerAreaHtml = `
              <div style="width: 100%; max-width: 320px; min-height: 110px; margin: 12px auto; background: rgba(239, 68, 68, 0.1); border: 1.5px dashed #ef4444; border-radius: 8px; padding: 16px 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
                <div style="font-size: 2rem; margin-bottom: 6px;">🚫</div>
                <div style="color: #f87171; font-weight: 800; font-size: 0.92rem;">
                  บัตรถูกระงับสิทธิ์ / คำสั่งซื้อเป็นโมฆะ
                </div>
              </div>
            `;
          } else {
            centerAreaHtml = `
              <div id="lookup_qr_${t.ticket_id}" style="width: 150px; height: 150px; margin: 0 auto 10px auto; background: #fff; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center;">
              </div>
              <div style="font-family: monospace; font-size: 0.8rem; color: var(--accent-cyan); text-align: center; letter-spacing: 0.5px; margin-bottom: 8px;">
                ${escapeHtml(t.qr_code_hash)}
              </div>
            `;
          }

          return `
            <div class="ep-ticket-pass" style="background: #0b1329; border: 1.5px solid var(--border-color); border-radius: 10px; padding: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); position: relative; overflow: hidden;">
              <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; margin-bottom: 8px;">
                <span style="font-size: 0.72rem; color: var(--accent-gold); font-weight: 700;">OFFICIAL E-TICKET #${idx + 1}</span>
                ${statusBadgeHtml}
              </div>
              <div style="font-size: 1.1rem; font-weight: 800; color: var(--accent-gold); margin-bottom: 2px;">
                ${escapeHtml(t.tier_name)}
              </div>
              <div style="font-size: 0.85rem; color: #fff; margin-bottom: 10px;">
                ผู้ถือบัตร: <strong>${escapeHtml(t.attendee_name || '-')}</strong> (โทร: ${escapeHtml(t.attendee_phone || '-')})
              </div>

              <!-- SINGLE-USE TICKET BADGE -->
              <div class="ep-single-use-badge" style="margin: 6px auto 10px auto; max-width: 280px; padding: 6px 10px;">
                <div class="ep-single-use-badge-text" style="font-size: 0.92rem;">
                  <span>🛡️</span> 1 คิวอาร์โค้ด ใช้ได้ 1 ท่านเท่านั้น
                </div>
              </div>

              ${centerAreaHtml}

              <div style="background: rgba(0,0,0,0.3); border-radius: 6px; padding: 8px; font-size: 0.75rem; color: var(--text-muted); display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
                <div>รหัสบัตร: <strong style="color: #fff;">${t.ticket_id}</strong></div>
                <div>คำสั่งซื้อ: <strong style="color: #fff;">${t.order_id || '-'}</strong></div>
                <div>ริสต์แบนด์: <strong style="color: #a5b4fc;">${t.wristband_id || 'รับหน้าประตู'}</strong></div>
                <div>จำนวนเข้างาน: <strong style="color: #fff;">${t.entry_count || 0} ครั้ง</strong></div>
              </div>

              ${isApproved ? `
                <button type="button" onclick="downloadSingleTicketQR('${t.ticket_id}')" style="background: rgba(14, 165, 233, 0.15); border: 1px solid rgba(14, 165, 233, 0.4); color: #38bdf8; border-radius: 4px; padding: 5px 10px; font-size: 0.75rem; font-weight: 700; cursor: pointer; margin-top: 8px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;">
                  📥 ดาวน์โหลดภาพ QR Code บัตรใบนี้ (PNG)
                </button>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Render QR codes strictly only for approved tickets
    setTimeout(() => {
      evaluatedTickets.forEach(({ ticket: t, isApproved }) => {
        if (isApproved) {
          const qrBox = document.getElementById(`lookup_qr_${t.ticket_id}`);
          if (qrBox && typeof QRCode !== 'undefined') {
            qrBox.innerHTML = '';
            new QRCode(qrBox, {
              text: t.qr_code_hash,
              width: 138,
              height: 138,
              colorDark: '#000000',
              colorLight: '#ffffff'
            });
          }
        }
      });
    }, 50);

    // If it was pending and just transitioned to approved, play sound
    const nowHasPending = document.querySelectorAll('.ep-ticket-pending-card').length > 0;
    if (hadPendingBefore && !nowHasPending && silent) {
      try {
        if (typeof audioAlert !== 'undefined' && audioAlert && audioAlert.playValidPass) {
          audioAlert.playValidPass();
        }
      } catch (e) {}
    }

    startLookupAutoSync();
  };

  // ==========================================================================
  // THERMAL 80MM UNIFIED PRINT ENGINE FOR ONLINE BOOKING (RECEIPT & TICKETS)
  // ==========================================================================
  function resolveCurrentBookingOrderAndTickets() {
    let order = lastBookingResult?.order;
    let payment = lastBookingResult?.payment;
    let tickets = lastBookingResult?.tickets;
    if ((!order || !order.order_id) && typeof EventPayDB !== 'undefined') {
      const orderIdEl = document.getElementById('succOrderId') || document.getElementById('rcpOrderId');
      let orderId = orderIdEl ? orderIdEl.textContent.trim() : null;
      if (!orderId && currentWaitingOrderId) {
        orderId = currentWaitingOrderId;
      }
      if (orderId) {
        order = EventPayDB.get('orders', orderId);
        payment = (EventPayDB.find('payments', p => p.order_id === orderId) || [])[0] || {};
        tickets = EventPayDB.find('tickets', t => t.order_id === orderId) || [];
      }
    }
    return { order: order || {}, payment: payment || {}, tickets: tickets || [] };
  }

  function renderBookingThermalPrint(order, tickets, mode, payment) {
    const container = document.getElementById('bookingThermalPrintContainer');
    if (!container) return;

    order = order || {};
    tickets = tickets || [];
    payment = payment || {};

    const summaryByTier = {};
    tickets.forEach(t => {
      const tierName = t.tier_name || 'บัตรคอนเสิร์ต';
      if (!summaryByTier[tierName]) {
        summaryByTier[tierName] = { qty: 0, tier_id: t.tier_id, price: 0 };
      }
      summaryByTier[tierName].qty++;
    });

    const allTiers = (typeof EventPayDB !== 'undefined' && EventPayDB.getAll) ? EventPayDB.getAll('ticket_tiers') : [];
    Object.keys(summaryByTier).forEach(tName => {
      const item = summaryByTier[tName];
      const tierObj = allTiers.find(x => x.tier_id === item.tier_id || x.name === tName);
      item.price = tierObj ? tierObj.price : (order.total_amount && tickets.length > 0 ? (order.total_amount / tickets.length) : 0);
    });

    const formattedRcpId = `RCP-${new Date(order.created_at || Date.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${(order.order_id || '0000').slice(-4)}`;
    let html = '';

    // 1. PAGE 1: SIMPLIFIED THERMAL RECEIPT (80MM ROLL) - AUTO-CUT 1
    if (mode === 'ALL' || mode === 'RECEIPT_ONLY') {
      html += `
        <div class="ep-thermal-cut-page" style="text-align: center; font-size: 11px; line-height: 1.35; color: #000;">
          <div style="font-size: 13px; font-weight: 900; margin-bottom: 2px; letter-spacing: 0.5px;">*** ใบเสร็จรับเงิน ***</div>
          <div style="font-size: 14px; font-weight: 900; margin-bottom: 2px;">บริษัท ไอซ์ โปรซาวด์ จำกัด</div>
          <div style="font-size: 11px; font-weight: 700; margin-bottom: 2px;">EVENTPAY CONCERT OFFICIAL 2026</div>
          <div style="font-size: 9.5px; margin-bottom: 1px;">728 ถ.เพชรเกษม ต.ห้วยจรเข้ อ.เมืองนครปฐม จ.นครปฐม 73000</div>
          <div style="font-size: 9.5px; margin-bottom: 4px;">โทรศัพท์: 086-366-4434, 095-761-4224</div>
          
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          
          <table style="width: 100%; font-size: 10px; line-height: 1.4; text-align: left;">
            <tr>
              <td style="width: 35%;">เลขที่ใบเสร็จ:</td>
              <td style="text-align: right; font-weight: 700;">${escapeHtml(formattedRcpId)}</td>
            </tr>
            <tr>
              <td>อ้างอิงออเดอร์:</td>
              <td style="text-align: right; font-weight: 700;">${escapeHtml(order.order_id || '-')}</td>
            </tr>
            <tr>
              <td>วันที่-เวลา:</td>
              <td style="text-align: right;">${new Date(order.created_at || Date.now()).toLocaleString('th-TH')}</td>
            </tr>
            <tr>
              <td>ผู้ซื้อ:</td>
              <td style="text-align: right; font-weight: 700;">${escapeHtml(order.customer_name || 'ลูกค้าทั่วไป')}</td>
            </tr>
            ${order.customer_phone ? `
            <tr>
              <td>เบอร์โทร:</td>
              <td style="text-align: right;">${escapeHtml(order.customer_phone)}</td>
            </tr>` : ''}
            <tr>
              <td>ช่องทาง:</td>
              <td style="text-align: right; font-weight: 700;">ระบบจองออนไลน์ (Online Self-Service)</td>
            </tr>
          </table>

          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>

          <table style="width: 100%; font-size: 10px; line-height: 1.4; text-align: left;">
            <thead>
              <tr style="border-bottom: 1px solid #000;">
                <th style="padding-bottom: 2px;">รายการบัตร</th>
                <th style="text-align: center; padding-bottom: 2px; width: 15%;">จน.</th>
                <th style="text-align: right; padding-bottom: 2px; width: 30%;">รวม (บาท)</th>
              </tr>
            </thead>
            <tbody>
      `;

      const tierKeys = Object.keys(summaryByTier);
      if (tierKeys.length > 0) {
        tierKeys.forEach(tierName => {
          const item = summaryByTier[tierName];
          const subtotal = item.price * item.qty;
          html += `
            <tr>
              <td style="padding-top: 2px;">${escapeHtml(tierName)}</td>
              <td style="text-align: center; padding-top: 2px;">${item.qty}</td>
              <td style="text-align: right; padding-top: 2px;">฿${Math.round(subtotal).toLocaleString('th-TH')}</td>
            </tr>
          `;
        });
      } else {
        html += `
          <tr>
            <td style="padding-top: 2px;">บัตรคอนเสิร์ต</td>
            <td style="text-align: center; padding-top: 2px;">1</td>
            <td style="text-align: right; padding-top: 2px;">฿${Math.round(order.total_amount || 0).toLocaleString('th-TH')}</td>
          </tr>
        `;
      }

      html += `
            </tbody>
          </table>

          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>

          <table style="width: 100%; font-size: 11px; line-height: 1.4; text-align: left;">
            <tr>
              <td style="font-weight: 900; font-size: 12px;">ยอดรวมสุทธิ:</td>
              <td style="text-align: right; font-weight: 900; font-size: 13px;">฿${Math.round(order.total_amount || 0).toLocaleString('th-TH')}</td>
            </tr>
          </table>
          <div style="font-size: 9.5px; text-align: right; color: #222; margin-top: 1px;">
            (${convertNumberToThaiBaht(order.total_amount || 0)})
          </div>

          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>

          <table style="width: 100%; font-size: 10px; line-height: 1.4; text-align: left;">
            <tr>
              <td>วิธีชำระเงิน:</td>
              <td style="text-align: right; font-weight: 700;">โอนเงินผ่านระบบพร้อมเพย์</td>
            </tr>
            <tr>
              <td>เลขอ้างอิง:</td>
              <td style="text-align: right; font-weight: 700; font-family: monospace;">${escapeHtml(payment.bank_ref || order.bank_ref || 'AUTO-PROMPTPAY-CONFIRMED')}</td>
            </tr>
          </table>

          <div style="border-top: 1px dashed #000; margin: 6px 0 4px 0;"></div>
          <div style="font-size: 9.5px; text-align: center;">ขอบพระคุณที่ร่วมเป็นส่วนหนึ่งของคอนเสิร์ตประวัติศาสตร์</div>
          <div style="font-size: 8.5px; text-align: center; color: #444; margin-top: 2px;">--- สิ้นสุดใบเสร็จรับเงิน (Auto-Cut) ---</div>
        </div>
      `;
    }

    // 2. PAGE 2 TO N: FULL-BLEED QR TICKETS (1 TICKET PER PERSON, 1:1 RATIO)
    if (mode === 'ALL' || mode === 'TICKETS_ONLY') {
      tickets.forEach((ticket, idx) => {
        html += `
          <div class="ep-thermal-cut-page" style="text-align: center; font-size: 11px; line-height: 1.35; color: #000;">
            <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.5px;">EVENTPAY CONCERT 2026</div>
            <div style="font-size: 16px; font-weight: 900; margin: 2px 0; letter-spacing: 0.5px;">${escapeHtml(ticket.tier_name)}</div>
            <div style="font-size: 11px; margin-bottom: 4px;">ผู้ถือบัตร: <strong>${escapeHtml(ticket.attendee_name || order.customer_name || '-')}</strong> (ใบที่ ${idx + 1}/${tickets.length})</div>

            <!-- SINGLE-USE TICKET BADGE -->
            <div style="border: 1.5px solid #000; border-radius: 4px; padding: 3px 6px; margin: 4px auto 6px auto; font-size: 10px; font-weight: 900; max-width: 230px;">
              🛡️ 1 คิวอาร์โค้ด ใช้ได้ 1 ท่านเท่านั้น
            </div>

            <!-- FULL-BLEED HIGH-CONTRAST QR CODE (195-200PX) -->
            <div id="booking_thermal_qr_${ticket.ticket_id}" style="display: flex; justify-content: center; align-items: center; margin: 4px auto; width: 195px; height: 195px;"></div>

            <div style="font-family: monospace; font-size: 11px; font-weight: 800; letter-spacing: 1px; margin: 4px 0;">
              ${escapeHtml(ticket.qr_code_hash)}
            </div>

            <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>

            <table style="width: 100%; font-size: 10px; line-height: 1.4; text-align: left;">
              <tr>
                <td style="width: 40%;">รหัสบัตร:</td>
                <td style="text-align: right; font-weight: 700; font-family: monospace;">${escapeHtml(ticket.ticket_id)}</td>
              </tr>
              <tr>
                <td>คำสั่งซื้อ:</td>
                <td style="text-align: right; font-weight: 700; font-family: monospace;">${escapeHtml(ticket.order_id || order.order_id || '-')}</td>
              </tr>
              <tr>
                <td>สถานะประตู:</td>
                <td style="text-align: right; font-weight: 700;">${escapeHtml(ticket.gate_status || 'WAITING_ENTRY')}</td>
              </tr>
              <tr>
                <td>ริสต์แบนด์:</td>
                <td style="text-align: right; font-weight: 700;">${escapeHtml(ticket.wristband_id || 'รับสายรัดข้อมือหน้างาน')}</td>
              </tr>
            </table>

            <div style="border-top: 1px dashed #000; margin: 5px 0 3px 0;"></div>
            <div style="font-size: 9px; text-align: center; color: #222;">กรุณาแสดง QR Code นี้ที่ทางเข้าเพื่อสแกนและรับริสต์แบนด์</div>
            <div style="font-size: 8px; text-align: center; color: #555; margin-top: 1px;">--- สิ้นสุดบัตรผ่านประตู (Auto-Cut) ---</div>
          </div>
        `;
      });
    }

    container.innerHTML = html;
  }

  function executeBookingThermalPrint(order, tickets, mode, payment) {
    const printContainer = document.getElementById('bookingThermalPrintContainer');
    if (!printContainer) {
      window.print();
      return;
    }

    renderBookingThermalPrint(order, tickets, mode, payment);

    if (mode === 'ALL' || mode === 'TICKETS_ONLY') {
      tickets.forEach(ticket => {
        const qrBox = document.getElementById(`booking_thermal_qr_${ticket.ticket_id}`);
        if (qrBox && typeof QRCode !== 'undefined') {
          qrBox.innerHTML = '';
          new QRCode(qrBox, {
            text: ticket.qr_code_hash,
            width: 195,
            height: 195,
            colorDark: '#000000',
            colorLight: '#ffffff'
          });
        }
      });
    }

    setTimeout(() => {
      document.body.classList.add('printing-booking-thermal');
      printContainer.style.display = 'block';

      const cleanup = () => {
        document.body.classList.remove('printing-booking-thermal');
        printContainer.style.display = 'none';
        window.removeEventListener('afterprint', cleanup);
      };

      window.addEventListener('afterprint', cleanup);
      window.print();

      setTimeout(() => {
        if (document.body.classList.contains('printing-booking-thermal')) {
          cleanup();
        }
      }, 2500);
    }, 150);
  }

  // ==========================================================================
  // SMART EXPORT & PRINT FUNCTIONS (MOBILE-FRIENDLY & DESKTOP THERMAL DUAL-ENGINE)
  // ==========================================================================
  window.printAllReceiptAndTickets = function () {
    const { order, payment, tickets } = resolveCurrentBookingOrderAndTickets();
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (typeof SlipGenerator !== 'undefined' && order && order.order_id) {
      SlipGenerator.downloadAllSlips(order, payment, tickets);
    } else if (!isMobile) {
      executeBookingThermalPrint(order, tickets, 'ALL', payment);
    } else {
      window.print();
    }
  };

  window.printReceiptOnly = function () {
    const { order, payment, tickets } = resolveCurrentBookingOrderAndTickets();
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (typeof SlipGenerator !== 'undefined' && order && order.order_id) {
      SlipGenerator.downloadReceiptSlip(order, payment, tickets);
    } else if (!isMobile) {
      executeBookingThermalPrint(order, tickets, 'RECEIPT_ONLY', payment);
    } else {
      window.print();
    }
  };

  window.printTicketsOnly = function () {
    const { order, payment, tickets } = resolveCurrentBookingOrderAndTickets();
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (typeof SlipGenerator !== 'undefined' && tickets && tickets.length > 0) {
      tickets.forEach((ticket, idx) => {
        setTimeout(() => {
          SlipGenerator.downloadTicketSlip(ticket, order, idx + 1, tickets.length);
        }, idx * 300);
      });
    } else if (!isMobile) {
      executeBookingThermalPrint(order, tickets, 'TICKETS_ONLY', payment);
    } else {
      window.print();
    }
  };

  // ==========================================================================
  // BOOKING DUAL-MODE ENGINE (LIVE Mode Default vs TEST Mode)
  // ==========================================================================
  window.currentBookingUiMode = 'LIVE';

  function initBookingUiMode() {
    let savedMode = 'LIVE';
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('mode') === 'test') {
        savedMode = 'TEST';
      } else if (localStorage.getItem('ep_booking_ui_mode') === 'TEST') {
        savedMode = 'TEST';
      }
    } catch (e) {}
    setBookingUiMode(savedMode, false);
  }
  window.initBookingUiMode = initBookingUiMode;

  function toggleBookingUiMode() {
    const nextMode = window.currentBookingUiMode === 'LIVE' ? 'TEST' : 'LIVE';
    setBookingUiMode(nextMode, true);
  }
  window.toggleBookingUiMode = toggleBookingUiMode;

  function setBookingUiMode(mode, notifyUser) {
    window.currentBookingUiMode = mode === 'TEST' ? 'TEST' : 'LIVE';
    try {
      localStorage.setItem('ep_booking_ui_mode', window.currentBookingUiMode);
    } catch (e) {}

    const simBox = document.getElementById('bookingDevSimulateBox');
    const badgeText = document.getElementById('bookingModeBadgeText');
    const badgeDot = document.getElementById('bookingModeBadgeDot');
    const badge = document.getElementById('bookingModeBadge');

    if (window.currentBookingUiMode === 'TEST') {
      if (simBox) simBox.style.display = 'block';
      if (badgeText) badgeText.textContent = '🧪 TEST (โหมดทดสอบ)';
      if (badgeDot) badgeDot.style.background = '#f59e0b';
      if (badge) {
        badge.style.background = 'rgba(245, 158, 11, 0.15)';
        badge.style.borderColor = '#f59e0b';
        badge.style.color = '#f59e0b';
      }
    } else {
      if (simBox) simBox.style.display = 'none';
      if (badgeText) badgeText.textContent = '🟢 LIVE (หน้างานจริง)';
      if (badgeDot) badgeDot.style.background = '#10b981';
      if (badge) {
        badge.style.background = 'rgba(16, 185, 129, 0.15)';
        badge.style.borderColor = '#10b981';
        badge.style.color = '#34d399';
      }
    }

    if (notifyUser) {
      console.log(`[Booking UI] Switched mode to: ${window.currentBookingUiMode}`);
    }
  }
  window.setBookingUiMode = setBookingUiMode;

  function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

})();
