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
    initPaymentMode();
    loadEventDetails();
    renderTiers();
    syncTiersFromMaster();
    updateBookingSummary();
    setupInputListeners();
    setupSSEListener();

    // ปลดล็อก Web Audio เมื่อผู้ใช้แตะหน้าจอครั้งแรก
    document.addEventListener('click', function unlockOnce() {
      if (audioAlert) audioAlert.unlockAudio();
      document.removeEventListener('click', unlockOnce);
    }, { once: true });
  }

  function syncTiersFromMaster() {
    if (typeof fetch === 'undefined') return;
    fetch('/api/db/ticket_tiers')
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

    if (mode === 'system_c') {
      if (legacySlipArea) legacySlipArea.style.display = 'none';
      if (zeroSlipRadar) zeroSlipRadar.style.display = 'block';
      if (step3Title) step3Title.textContent = 'ชำระเงินผ่านพร้อมเพย์ (Auto Zero-Slip)';
      if (btnSubmit) {
        btnSubmit.innerHTML = '⚡ ยืนยันการจองและเริ่มตรวจจับเงินเข้าอัตโนมัติ';
        btnSubmit.style.background = 'linear-gradient(135deg, #059669 0%, #10b981 100%)';
        btnSubmit.style.boxShadow = '0 4px 18px rgba(16, 185, 129, 0.4)';
      }
    } else {
      if (legacySlipArea) legacySlipArea.style.display = 'block';
      if (zeroSlipRadar) zeroSlipRadar.style.display = 'none';
      if (step3Title) step3Title.textContent = 'ชำระเงินและแนบสลิป';
      if (btnSubmit) {
        btnSubmit.innerHTML = '⚡ ยืนยันการจองและส่งสลิปให้ฝ่ายการเงินตรวจสอบ';
        btnSubmit.style.background = 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)';
        btnSubmit.style.boxShadow = '0 4px 18px rgba(245, 158, 11, 0.4)';
      }
    }
  }

  function startZeroSlipCountdown(seconds = 600) {
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
        const evtSource = new EventSource('/api/events');
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
      // ตั้งค่าเริ่มต้น: โซนแรกมีจำนวน 1 ใบ
      if (!(tier.tier_id in bookingQuantities)) {
        bookingQuantities[tier.tier_id] = (index === 0 ? 1 : 0);
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
      startZeroSlipCountdown(600);
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
        if (statusText) statusText.textContent = '✓ แนบรูปภาพสลิปแล้ว กรุณากรอกเลขอ้างอิงจากสลิป';

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

    if (previewContainer) previewContainer.style.display = 'none';
    if (uploadZone) uploadZone.style.borderColor = '#38bdf8';
    if (statusText) statusText.textContent = '';

    validateFormReadiness();
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

    const isReady = isSystemC
      ? (count > 0 && total > 0 && Boolean(name) && Boolean(phone))
      : (count > 0 && total > 0 && Boolean(name) && Boolean(phone) && Boolean(bankRef) && Boolean(attachedSlipBase64));

    if (btn) {
      if (isReady) {
        btn.style.opacity = '1';
        btn.style.boxShadow = isSystemC ? '0 4px 22px rgba(16, 185, 129, 0.7)' : '0 4px 22px rgba(245, 158, 11, 0.7)';
      } else {
        btn.style.opacity = '0.9';
        btn.style.boxShadow = isSystemC ? '0 4px 14px rgba(16, 185, 129, 0.3)' : '0 4px 14px rgba(245, 158, 11, 0.3)';
      }
    }

    if (notice) {
      if (isReady) {
        notice.innerHTML = isSystemC
          ? '<span style="color: #34d399; font-weight: 700;">✅ ข้อมูลครบถ้วน สแกน QR ด้านบน และกดยืนยันเพื่อออกตั๋วอัตโนมัติ</span>'
          : '<span style="color: #10b981; font-weight: 700;">✅ ข้อมูลครบถ้วน พร้อมส่งสลิปให้ฝ่ายการเงินตรวจสอบค่ะ</span>';
      } else {
        const missing = [];
        if (count === 0) missing.push('เลือกประเภทบัตร');
        if (!name) missing.push('ชื่อ-นามสกุลผู้ซื้อ');
        if (!phone) missing.push('เบอร์โทรศัพท์');
        if (!isSystemC) {
          if (!attachedSlipBase64) missing.push('แนบรูปสลิป');
          if (!bankRef) missing.push('เลขที่อ้างอิงสลิป');
        }
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

    const isSystemC = (currentPaymentConfig && currentPaymentConfig.mode === 'system_c');

    if (!isSystemC) {
      if (!attachedSlipBase64) {
        alert('⚠️ กรุณาแนบรูปภาพสลิปโอนเงิน เพื่อให้ฝ่ายบัญชีตรวจสอบยอดเงินเข้าค่ะ\n(หรือกดปุ่ม "⚡ จำลองแนบสลิปทดสอบ" เพื่อทดสอบความรวดเร็ว)');
        if (uploadZone) {
          uploadZone.style.borderColor = '#ef4444';
          uploadZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (notice) notice.innerHTML = '<span style="color: #ef4444; font-weight: 700;">❌ กรุณาแนบรูปภาพสลิปโอนเงิน</span>';
        return;
      }

      if (!bankRef) {
        alert('⚠️ กรุณากรอกเลขที่อ้างอิงสลิปธนาคาร (เช่น รหัสอ้างอิงการโอนเงิน) ก่อนนะคะ');
        if (bankRefInput) {
          bankRefInput.style.borderColor = '#ef4444';
          bankRefInput.focus();
        }
        if (notice) notice.innerHTML = '<span style="color: #ef4444; font-weight: 700;">❌ กรุณากรอกเลขที่อ้างอิงสลิปธนาคาร</span>';
        return;
      }
    }

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
    const finalBankRef = isSystemC ? ('AUTO-PROMPTPAY-' + Date.now().toString().slice(-6)) : bankRef;
    const finalSlipUrl = isSystemC ? '' : (attachedSlipBase64 || '');

    const orderData = {
      customer_name: custName,
      customer_phone: custPhone,
      payment_method: 'TRANSFER',
      shift_id: 'SHIFT-ONLINE-SELF',
      bank_ref: finalBankRef,
      slip_url: finalSlipUrl,
      requires_verification: true,
      items: items
    };

    try {
      const result = EventPayDB.createOrder(orderData, 'ONLINE_CUSTOMER');
      currentWaitingOrderId = result.order.order_id;

      if (isSystemC) {
        if (effectiveTotal !== total) {
          EventPayDB.update('orders', result.order.order_id, { total_amount: effectiveTotal });
          const p = EventPayDB.getAll('payments', p => p.order_id === result.order.order_id)[0];
          if (p) EventPayDB.update('payments', p.payment_id, { amount: effectiveTotal });
        }

        startZeroSlipCountdown(600);

        const btn = document.getElementById('btnSubmitBooking');
        if (btn) {
          btn.innerHTML = '🟢 ระบบกำลังรอตรวจจับเงินเข้าอัตโนมัติ (1.5 วินาที)...';
          btn.disabled = true;
        }
        if (notice) {
          notice.innerHTML = '<span style="color: #34d399; font-weight: 700;">📡 บันทึกคำสั่งซื้อแล้ว ระบบกำลังรอตรวจจับเงินเข้าจากแอปธนาคารอัตโนมัติ</span>';
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

  let currentBookingSuccessResult = null;

  function displayBookingSuccess(result) {
    currentBookingSuccessResult = result;
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
    if (rcpGrandTotal) rcpGrandTotal.textContent = `฿${Math.round(order.total_amount).toLocaleString('th-TH')}`;
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

          <button type="button" class="ep-nav-btn" style="background: rgba(14, 165, 233, 0.15); border: 1.5px solid #0284c7; color: #38bdf8; border-radius: 6px; padding: 8px 12px; font-size: 0.82rem; font-weight: 700; cursor: pointer; margin-top: 10px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="downloadSingleTicketSlip('${ticket.ticket_id}')">
            📱 บันทึกสลิปตั๋ว QR ใบนี้ (ภาพมาตรฐาน 80 มม.)
          </button>
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
    document.body.classList.add('print-lookup-tickets');
    window.print();
    setTimeout(() => {
      document.body.classList.remove('print-lookup-tickets');
    }, 1000);
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

    container.innerHTML = `
      <div style="font-size: 0.88rem; color: #34d399; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span>🎉 พบบัตรคอนเสิร์ตจำนวน ${matchedTickets.length} ใบ:</span>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button type="button" class="ep-nav-btn" style="font-size: 0.78rem; padding: 6px 12px; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #fff; font-weight: 800; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.3);" onclick="window.downloadAllMatchedTicketSlips()">
            📱 บันทึกสลิปตั๋วทั้งหมด (1-Click)
          </button>
          <button type="button" class="ep-nav-btn" style="font-size: 0.78rem; padding: 6px 12px; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #fff; font-weight: 800; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);" onclick="window.downloadOrPrintTickets()">
            🖨️ พิมพ์ / แคปเจอร์
          </button>
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${matchedTickets.map((t, idx) => {
          const parentOrder = allOrders.find(o => o.order_id === t.order_id);
          const isPending = (parentOrder && parentOrder.payment_status === 'PENDING_VERIFICATION') || 
                            (t.is_void && parentOrder && parentOrder.payment_status !== 'VOID');
          const isVoid = (parentOrder && parentOrder.payment_status === 'VOID') || (t.is_void && !isPending);
          const isApproved = (parentOrder && parentOrder.payment_status === 'PAID') || (!t.is_void && !isVoid);

          let statusBadgeHtml = '';
          if (isPending) {
            statusBadgeHtml = '<span style="font-size: 0.75rem; color: #f59e0b; font-weight: 800; background: rgba(245, 158, 11, 0.15); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.4);">● กำลังตรวจสอบ</span>';
          } else if (isVoid) {
            statusBadgeHtml = '<span style="font-size: 0.75rem; color: #ef4444; font-weight: 800; background: rgba(239, 68, 68, 0.15); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.4);">● บัตรโมฆะ</span>';
          } else {
            const gateText = t.gate_status === 'ENTERED' ? 'เข้างานแล้ว' : 'อนุมัติ';
            statusBadgeHtml = `<span style="font-size: 0.75rem; color: #10b981; font-weight: 800; background: rgba(16, 185, 129, 0.15); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.4);">● ${gateText}</span>`;
          }

          let centerAreaHtml = '';
          if (isPending) {
            centerAreaHtml = `
              <div class="ep-ticket-pending-card" style="width: 100%; max-width: 320px; min-height: 140px; margin: 12px auto; background: rgba(15, 23, 42, 0.75); border: 1.5px dashed #f59e0b; border-radius: 8px; padding: 16px 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-shadow: 0 0 15px rgba(245, 158, 11, 0.15);">
                <div style="font-size: 2rem; margin-bottom: 6px; animation: spinHourglass 3s linear infinite;">⏳</div>
                <div style="color: #fbbf24; font-weight: 800; font-size: 0.95rem; line-height: 1.4;">
                  ระบบรอสร้างคิวอาร์โค้ดบัตร<br>เมื่อธนาคารรับเงินแล้ว
                </div>
                <div style="font-size: 0.76rem; color: #94a3b8; margin-top: 6px;">
                  เจ้าหน้าที่/ระบบ AI ตรวจสอบสเตทเมนต์ยอดเงินเข้าบัญชี
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
                <button type="button" onclick="downloadSingleTicketSlip('${t.ticket_id}')" style="background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #fff; border: none; border-radius: 4px; padding: 7px 10px; font-size: 0.78rem; font-weight: 800; cursor: pointer; margin-top: 8px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 2px 6px rgba(2, 132, 199, 0.3);">
                  📱 บันทึกสลิปตั๋ว QR ภาพมาตรฐานสากล (PNG)
                </button>
                <button type="button" onclick="downloadSingleTicketQR('${t.ticket_id}')" style="background: rgba(14, 165, 233, 0.12); border: 1px solid rgba(14, 165, 233, 0.4); color: #38bdf8; border-radius: 4px; padding: 5px 10px; font-size: 0.72rem; font-weight: 600; cursor: pointer; margin-top: 4px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 4px;">
                  📥 เฉพาะภาพ QR Code เดี่ยวๆ (PNG)
                </button>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Render QR codes only for approved tickets
    setTimeout(() => {
      matchedTickets.forEach(t => {
        const parentOrder = allOrders.find(o => o.order_id === t.order_id);
        const isPending = (parentOrder && parentOrder.payment_status === 'PENDING_VERIFICATION') || 
                          (t.is_void && parentOrder && parentOrder.payment_status !== 'VOID');
        const isVoid = (parentOrder && parentOrder.payment_status === 'VOID') || (t.is_void && !isPending);
        const isApproved = (parentOrder && parentOrder.payment_status === 'PAID') || (!t.is_void && !isVoid);

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
  // SMART PRINT FUNCTIONS (ALL / RECEIPT ONLY / TICKETS ONLY)
  // ==========================================================================
  window.printAllReceiptAndTickets = function () {
    document.body.classList.remove('print-receipt-only', 'print-tickets-only');
    window.print();
  };

  window.printReceiptOnly = function () {
    document.body.classList.add('print-receipt-only');
    document.body.classList.remove('print-tickets-only');
    window.print();
    setTimeout(() => {
      document.body.classList.remove('print-receipt-only');
    }, 1000);
  };

  window.printTicketsOnly = function () {
    document.body.classList.add('print-tickets-only');
    document.body.classList.remove('print-receipt-only');
    window.print();
    setTimeout(() => {
      document.body.classList.remove('print-tickets-only');
    }, 1000);
  };

  // ==========================================================================
  // MOBILE SLIP DOWNLOAD (GLOBAL BANK STANDARD SLIP ENGINE)
  // ==========================================================================
  window.downloadAllSlipsForCurrentOrder = async function () {
    if (!currentBookingSuccessResult) {
      alert('ไม่พบข้อมูลคำสั่งซื้อที่จะดาวน์โหลด');
      return;
    }
    const { order, payment, tickets } = currentBookingSuccessResult;
    if (window.SlipGenerator) {
      await window.SlipGenerator.downloadAllSlips(order, payment, tickets);
    } else {
      alert('โมดูลสร้างสลิปกำลังเริ่มต้น กรุณาลองใหม่อีกครั้ง');
    }
  };

  window.downloadReceiptSlipForCurrentOrder = async function () {
    if (!currentBookingSuccessResult) {
      alert('ไม่พบข้อมูลคำสั่งซื้อที่จะดาวน์โหลด');
      return;
    }
    const { order, payment, tickets } = currentBookingSuccessResult;
    if (window.SlipGenerator) {
      await window.SlipGenerator.downloadReceiptSlip(order, payment, tickets);
    }
  };

  window.downloadAllTicketSlipsForCurrentOrder = async function () {
    if (!currentBookingSuccessResult) {
      alert('ไม่พบข้อมูลคำสั่งซื้อที่จะดาวน์โหลด');
      return;
    }
    const { order, tickets } = currentBookingSuccessResult;
    if (window.SlipGenerator) {
      for (let i = 0; i < tickets.length; i++) {
        await new Promise(r => setTimeout(r, 280));
        await window.SlipGenerator.downloadTicketSlip(tickets[i], order, i + 1, tickets.length);
      }
    }
  };

  window.downloadSingleTicketSlip = async function (ticketId) {
    if (typeof EventPayDB === 'undefined' || !window.SlipGenerator) return;
    const ticket = EventPayDB.get('tickets', ticketId);
    if (!ticket) {
      alert('ไม่พบข้อมูลตั๋วใบนี้');
      return;
    }
    const order = EventPayDB.get('orders', ticket.order_id);
    await window.SlipGenerator.downloadTicketSlip(ticket, order || {}, 1, 1);
  };

  window.downloadAllMatchedTicketSlips = async function () {
    if (!window.SlipGenerator) return;
    const approvedCards = document.querySelectorAll('#lookupResultsContainer [id^="lookup_qr_"]');
    if (!approvedCards || approvedCards.length === 0) {
      alert('ไม่พบบัตรที่ได้รับการอนุมัติแล้ว');
      return;
    }
    for (let i = 0; i < approvedCards.length; i++) {
      const ticketId = approvedCards[i].id.replace('lookup_qr_', '');
      const ticket = EventPayDB.get('tickets', ticketId);
      if (ticket) {
        const order = EventPayDB.get('orders', ticket.order_id);
        await new Promise(r => setTimeout(r, 280));
        await window.SlipGenerator.downloadTicketSlip(ticket, order || {}, i + 1, approvedCards.length);
      }
    }
  };

  function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

})();
