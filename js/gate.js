/**
 * ============================================================================
 * EVENTPAY KIOSK GATE CONTROLLER (js/gate.js)
 * โครงการ: EventPay (Concert Payment & Secure Entry Platform)
 * พิกัด: D:\BillingApp\Antigravity\EventPay\js\gate.js
 * หน้าที่: ควบคุมการสแกน 3 ประสาน, กล้อง WebRTC, จอเขียวผ่าน vs จอแดงไซเรนลั่นลำโพง
 * ============================================================================
 */

(function () {
  'use strict';

  let audioAlert = null;
  let hwBridge = null;
  let currentCameraFacing = 'user'; // 'user' (กล้องหน้าตู้ Kiosk) หรือ 'environment'
  let passAutoCloseTimer = null;
  const currentGateId = 'GATE-01';
  const currentOperatorId = 'USER-GATE-01';
  window.currentGateDirection = 'IN';

  window.toggleGateDirection = function (forceMode) {
    if (forceMode) {
      window.currentGateDirection = forceMode;
    } else {
      window.currentGateDirection = window.currentGateDirection === 'IN' ? 'OUT' : 'IN';
    }
    updateGateDirectionUI();
  };

  function updateGateDirectionUI() {
    const btn = document.getElementById('btnGateDirectionToggle');
    const icon = document.getElementById('gateModeIcon');
    const text = document.getElementById('gateModeText');
    const title = document.getElementById('kioskGateTitle');
    const btnVerify = document.getElementById('btnVerifyGate');

    if (window.currentGateDirection === 'OUT') {
      if (btn) {
        btn.style.background = 'linear-gradient(135deg, #0284c7 0%, #0ea5e9 100%)';
        btn.style.borderColor = '#38bdf8';
        btn.style.boxShadow = '0 2px 8px rgba(14, 165, 233, 0.4)';
      }
      if (icon) icon.textContent = '🚶';
      if (text) text.textContent = 'โหมดประตู: ทางออก (OUT)';
      if (title) title.textContent = '🚪 GATE 1: NORTH KIOSK - โหมดทางออก (EXIT)';
      if (btnVerify) {
        btnVerify.style.background = 'linear-gradient(135deg, #0284c7 0%, #0ea5e9 100%)';
        btnVerify.innerHTML = '<span>🚶 สแกนออกจากงาน (VERIFY EXIT)</span>';
      }
    } else {
      if (btn) {
        btn.style.background = 'linear-gradient(135deg, #059669 0%, #10b981 100%)';
        btn.style.borderColor = '#34d399';
        btn.style.boxShadow = '0 2px 8px rgba(16, 185, 129, 0.35)';
      }
      if (icon) icon.textContent = '🚪';
      if (text) text.textContent = 'โหมดประตู: ทางเข้า (IN)';
      if (title) title.textContent = '🚪 GATE 1: NORTH KIOSK - โหมดทางเข้า (ENTRY)';
      if (btnVerify) {
        btnVerify.style.background = 'linear-gradient(135deg, var(--accent-green) 0%, #059669 100%)';
        btnVerify.innerHTML = '<span>🚀 ตรวจสอบสิทธิ์เข้างาน (VERIFY PASS)</span>';
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initGate();
  });

  function initGate() {
    try {
      if (typeof EventPayAudioAlert !== 'undefined') {
        audioAlert = new EventPayAudioAlert();
      }
      if (typeof EventPayHardwareBridge !== 'undefined') {
        hwBridge = new EventPayHardwareBridge();
      }
    } catch (e) {
      console.warn('Init instances warning:', e);
    }

    updateGateDirectionUI();

    loadGateInfo();
    updateGateStats();
    renderActiveOutsideBoard();
    updateKioskNetBadge();

    // ฟัง Real-time Broadcast จากเครื่องแม่ข่าย
    if (EventPayDB && typeof EventPayDB.onSyncEvent === 'function') {
      EventPayDB.onSyncEvent((data) => {
        updateGateStats();
        renderActiveOutsideBoard();
      });
    }

    // ดึงกระดานคนอยู่นอกงานแบบ Periodic Update ทุก 10 วินาที เพื่อรีเฟรชเวลา (agoStr)
    setInterval(() => {
      renderActiveOutsideBoard();
    }, 10000);

    // เริ่มเปิดกล้องอัตโนมัติ
    startCameraStream();

    // ติดตั้งตัวช่วยอำนวยความสะดวกในช่องกรอก QR Code
    initQrInputHelpers();

    // เริ่มต้นระบบ 2 โหมด Kiosk (Default: โหมดหน้างานจริง LIVE สะอาดตา 100%)
    initKioskMode();

    // ดักจับการแตะหน้าจอครั้งแรกเพื่อปลดล็อก Web Audio Autoplay ทันที
    document.addEventListener('click', function unlockOnce() {
      unlockKioskAudioAndCamera();
      document.removeEventListener('click', unlockOnce);
    }, { once: true });
  }

  function initQrInputHelpers() {
    const qrInput = document.getElementById('gateQrInput');
    if (qrInput) {
      qrInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const wbInput = document.getElementById('gateWbInput');
          // ถ้าอยู่ในโหมดทางออก (OUT) หรือถ้ามีค่าริสต์แบนด์อยู่แล้ว ให้กด Enter เพื่อ submit ตรวจสอบทันที
          if (window.currentGateDirection === 'OUT' || (wbInput && wbInput.value.trim())) {
            // อนุญาตให้ form submit ประมวลผล processGateScan() ทันที
          } else if (wbInput && !wbInput.value.trim()) {
            // ถ้าอยู่ในโหมดทางเข้า (IN) และยังไม่ได้ระบุริสต์แบนด์ ให้ข้ามไปโฟกัสช่องริสต์แบนด์
            e.preventDefault();
            wbInput.focus();
          }
        }
      });
    }
  }

  async function updateKioskNetBadge() {
    const badge = document.getElementById('kioskNetBadge');
    if (!badge) return;
    try {
      const res = await EventPayDB.checkMasterConnection();
      if (res && res.connected) {
        badge.textContent = '🟢 LAN MASTER CONNECTED';
        badge.style.background = 'rgba(34, 197, 94, 0.15)';
        badge.style.borderColor = 'var(--accent-green)';
        badge.style.color = 'var(--accent-green)';
      } else {
        badge.textContent = '🟡 LOCAL OFFLINE MODE';
        badge.style.background = 'rgba(234, 179, 8, 0.15)';
        badge.style.borderColor = 'var(--accent-gold)';
        badge.style.color = 'var(--accent-gold)';
      }
    } catch (e) {
      badge.textContent = '🟡 LOCAL OFFLINE MODE';
    }
  }

  function loadGateInfo() {
    const gate = EventPayDB.get('gates', currentGateId);
    if (gate) {
      const title = document.getElementById('kioskGateTitle');
      if (title) title.textContent = `🚪 ${gate.name}`;
    }

    const guard = EventPayDB.get('staff', currentOperatorId);
    if (guard) {
      const guardSpan = document.getElementById('kioskGuardName');
      if (guardSpan) guardSpan.textContent = `${guard.name} (${guard.staff_id})`;
    }
  }

  // ==========================================================================
  // 1. ปลดล็อกระบบเสียง Web Audio และเริ่มกล้อง
  // ==========================================================================
  window.unlockKioskAudioAndCamera = function () {
    if (audioAlert) {
      audioAlert.unlockAudio().then(() => {
        const banner = document.getElementById('kioskUnlockBanner');
        if (banner) banner.style.display = 'none';

        const badge = document.getElementById('badgeAudioStatus');
        if (badge) {
          badge.textContent = '🔊 ลำโพงไซเรน: พร้อมใช้งาน (Armed)';
          badge.style.background = '#064e3b';
          badge.style.borderColor = '#10b981';
        }
      });
    }
    startCameraStream();
  };

  // ==========================================================================
  // 2. ควบคุมกล้อง WebRTC และสลับกล้อง
  // ==========================================================================
  function startCameraStream() {
    const videoEl = document.getElementById('gateCameraVideo');
    const statusText = document.getElementById('cameraStatusText');

    if (!hwBridge || !videoEl) return;

    if (!hwBridge.isCameraSupported()) {
      if (statusText) {
        statusText.textContent = 'อุปกรณ์ไม่รองรับกล้องจริง (ใช้โหมดจำลองภาพถ่าย)';
        statusText.style.color = 'var(--accent-gold)';
      }
      return;
    }

    if (statusText) statusText.textContent = 'กำลังเปิดกล้อง...';

    hwBridge.startCamera(videoEl, null, currentCameraFacing)
      .then(() => {
        if (statusText) {
          statusText.textContent = 'กล้องทำงานปกติ (360x360 Ready)';
          statusText.style.color = 'var(--accent-green)';
        }
      })
      .catch(err => {
        console.warn('Camera stream warning:', err);
        if (statusText) {
          statusText.textContent = 'ไม่พบกล้อง/ไม่ได้รับอนุญาต (ใช้โหมดจำลองภาพถ่าย)';
          statusText.style.color = 'var(--accent-gold)';
        }
      });
  }

  window.switchCamera = function () {
    currentCameraFacing = currentCameraFacing === 'user' ? 'environment' : 'user';
    startCameraStream();
  };

  window.toggleKioskFullscreen = function () {
    if (!hwBridge) return;
    if (hwBridge.isFullscreen()) {
      hwBridge.exitFullscreen();
    } else {
      hwBridge.enterFullscreen();
    }
  };

  // ==========================================================================
  // 3. ตรวจสอบสิทธิ์ 3 ประสาน (Gate 3-Point Validation)
  // ==========================================================================
  window.processGateScan = function () {
    const qrInput = document.getElementById('gateQrInput');
    const wbInput = document.getElementById('gateWbInput');
    const videoEl = document.getElementById('gateCameraVideo');

    const qrVal = (qrInput?.value || '').trim();
    const wbVal = (wbInput?.value || '').trim();

    // อนุญาตให้สแกนเฉพาะริสต์แบนด์ได้ (โดยเฉพาะเมื่อออกจากงาน หรือกลับเข้ามาใหม่)
    if (!qrVal && !wbVal) {
      alert('กรุณายิงสแกน QR Code บนบัตร หรือแตะริสต์แบนด์');
      if (qrInput) qrInput.focus();
      return;
    }

    // ถ่ายภาพใบหน้าความเร็วสูงจากกล้อง 360x360 (< 40KB)
    let facePhotoDataUrl = '';
    let captureMeta = { byteSize: 0, durationMs: 0 };

    try {
      if (videoEl && videoEl.readyState >= 2 && hwBridge) {
        const capture = hwBridge.captureFace(videoEl, 360, 360);
        facePhotoDataUrl = capture.dataUrl;
        captureMeta = { byteSize: capture.byteSize, durationMs: capture.durationMs };
      } else {
        // Fallback จำลองรูปถ่ายใบหน้าหากไม่มีกล้องจริง
        facePhotoDataUrl = generateSimulatedFaceCanvas(qrVal || wbVal);
        captureMeta = { byteSize: 28500, durationMs: 15 };
      }
    } catch (e) {
      facePhotoDataUrl = generateSimulatedFaceCanvas(qrVal || wbVal);
      captureMeta = { byteSize: 28500, durationMs: 15 };
    }

    // เรียกแกนสมองตรวจสอบสิทธิ์ 3 ประสาน (Atomic Validation Engine)
    const result = EventPayDB.validateGateScan(qrVal, wbVal, facePhotoDataUrl, currentGateId, currentOperatorId, window.currentGateDirection);

    // ซิงก์ผลการสแกนไปยัง Master Server แบบ Asynchronous Background ทันทีหากเชื่อมต่ออยู่
    if (EventPayDB && EventPayDB.isMasterConnected) {
      try {
        fetch(`${EventPayDB.masterServerUrl}/api/gate/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            qrCode: qrVal,
            wristbandId: wbVal,
            facePhotoUrl: facePhotoDataUrl,
            gateId: currentGateId,
            operatorId: currentOperatorId,
            gateDirection: window.currentGateDirection
          })
        }).catch(() => {});
      } catch (e) {}
    }

    // อัปเดตกล่องแสดงภาพถ่ายใบหน้าล่าสุดบนหน้าจอหลัก
    updateLastFaceSnapshot(result, facePhotoDataUrl, captureMeta);
    updateGateStats();

    if (result.success) {
      handleGatePassSuccess(result, facePhotoDataUrl);
    } else {
      handleGateFraudDetected(result, facePhotoDataUrl);
    }
  };

  // ==========================================================================
  // 4. แสดงผลกรณีผ่าน (BIG GREEN PASS SCREEN)
  // ==========================================================================
  function handleGatePassSuccess(result, facePhotoUrl) {
    const ticket = result.ticket;

    // เล่นเสียง Chime นุ่มนวล
    if (audioAlert) audioAlert.playSuccessChime();

    const overlay = document.getElementById('overlayPass');
    const passOverlayTitle = document.getElementById('passOverlayTitle');
    const passMode = document.getElementById('passModeText');
    const passName = document.getElementById('passAttendeeName');
    const passTier = document.getElementById('passTierName');
    const passTktId = document.getElementById('passTicketId');
    const passWbId = document.getElementById('passWristbandId');
    const passImg = document.getElementById('passFaceImg');
    const passImgFirst = document.getElementById('passFaceImgFirst');
    const passBoxFirst = document.getElementById('passFaceBoxFirst');
    const passCurrentLabel = document.getElementById('passFaceCurrentLabel');

    if (result.mode === 'EXIT') {
      if (passOverlayTitle) passOverlayTitle.textContent = 'PASS - ออกจากงานเรียบร้อย';
      if (passMode) passMode.textContent = 'ออกจากงานเรียบร้อย ขอบคุณค่ะ (สามารถกลับเข้ามาใหม่ได้ด้วยริสต์แบนด์เดิม)';
      if (passBoxFirst && passImgFirst && ticket && ticket.face_photo_url) {
        passImgFirst.src = ticket.face_photo_url;
        passBoxFirst.style.display = 'block';
      } else if (passBoxFirst) {
        passBoxFirst.style.display = 'none';
      }
      if (passCurrentLabel) passCurrentLabel.textContent = '📸 รูปถ่ายขณะเดินออก (Exit Snapshot)';
      renderActiveOutsideBoard();
    } else if (result.mode === 'RE_ENTRY') {
      if (passOverlayTitle) passOverlayTitle.textContent = 'PASS - เข้างานได้';
      if (passMode) passMode.textContent = `ยินดีต้อนรับกลับเข้าสู่งาน (เข้าซ้ำครั้งที่ ${ticket.entry_count})`;
      if (passBoxFirst && passImgFirst && ticket && ticket.face_photo_url) {
        passImgFirst.src = ticket.face_photo_url;
        passBoxFirst.style.display = 'block';
      } else if (passBoxFirst) {
        passBoxFirst.style.display = 'none';
      }
      if (passCurrentLabel) passCurrentLabel.textContent = '📸 รูปถ่ายสดขณะนี้ (Live Camera)';

      // เอฟเฟกต์วูบหายอัตโนมัติจากกระดานคนอยู่นอกงาน (Smooth Auto-Remove)
      if (ticket) {
        const existingCard = document.getElementById(`outside-card-${ticket.ticket_id}`);
        if (existingCard) {
          existingCard.classList.add('removing');
          setTimeout(() => {
            if (existingCard && existingCard.parentNode) existingCard.parentNode.removeChild(existingCard);
            updateOutsideBadgeCount();
          }, 350);
        }
      }
      setTimeout(() => {
        renderActiveOutsideBoard();
      }, 400);
    } else {
      // FIRST_ENTRY
      if (passOverlayTitle) passOverlayTitle.textContent = 'PASS - เข้างานได้';
      if (passMode) passMode.textContent = 'ยินดีต้อนรับเข้าสู่งานคอนเสิร์ต (ลงทะเบียนครั้งแรกสำเร็จ)';
      if (passBoxFirst) passBoxFirst.style.display = 'none';
      if (passCurrentLabel) passCurrentLabel.textContent = '📸 รูปถ่ายลงทะเบียนแรก';
    }

    if (passName) passName.textContent = ticket ? (ticket.attendee_name || '-') : '-';
    if (passTier) passTier.textContent = ticket ? (ticket.tier_name || '-') : '-';
    if (passTktId) passTktId.textContent = ticket ? (ticket.ticket_id || '-') : '-';
    if (passWbId) passWbId.textContent = ticket ? (ticket.wristband_id || '-') : '-';
    if (passImg) passImg.src = facePhotoUrl;

    if (overlay) overlay.classList.add('show');

    // รีเซ็ตอัตโนมัติใน 3.2 วินาที เพื่อรับคนถัดไป
    if (passAutoCloseTimer) clearTimeout(passAutoCloseTimer);
    passAutoCloseTimer = setTimeout(() => {
      closePassScreen();
    }, 3200);
  }

  window.closePassScreen = function () {
    if (passAutoCloseTimer) clearTimeout(passAutoCloseTimer);
    const overlay = document.getElementById('overlayPass');
    if (overlay) overlay.classList.remove('show');

    // ล้างช่องกรอกและโฟกัสกลับช่อง QR Code
    resetInputs();
  };

  // ==========================================================================
  // 5. แสดงผลกรณีทุจริต/สวมสิทธิ์ (BIG FLASHING RED LOUDSPEAKER ALARM)
  // ==========================================================================
  function handleGateFraudDetected(result, facePhotoUrl) {
    // ลั่นเสียงไซเรนเตือนภัยความถี่สูง 800-1600Hz LFO ออกลำโพงภายนอก Kiosk ทันที!
    if (audioAlert) audioAlert.startAlarmSiren();

    const overlay = document.getElementById('overlayFraud');
    const textViolation = document.getElementById('fraudViolationText');
    const textTktId = document.getElementById('fraudTicketId');
    const textWbId = document.getElementById('fraudWristbandId');
    const textReason = document.getElementById('fraudReasonDetail');
    const fraudImg = document.getElementById('fraudFaceImg');

    if (textViolation) textViolation.textContent = `REJECT: ${result.message}`;
    if (textTktId) textTktId.textContent = result.ticket ? result.ticket.ticket_id : (document.getElementById('gateQrInput')?.value || '-');
    if (textWbId) textWbId.textContent = document.getElementById('gateWbInput')?.value || 'ไม่ได้ระบุ';
    if (textReason) textReason.textContent = `[${result.code}] ${result.message}`;
    if (fraudImg) fraudImg.src = facePhotoUrl;

    if (overlay) overlay.classList.add('show');
  }

  window.silenceAlarmAndReset = function () {
    // เจ้าหน้าที่กดหยุดเสียงไซเรนเตือนภัย
    if (audioAlert) audioAlert.stopAlarmSiren();

    const overlay = document.getElementById('overlayFraud');
    if (overlay) overlay.classList.remove('show');

    resetInputs();
  };

  function resetInputs() {
    const qrInput = document.getElementById('gateQrInput');
    const wbInput = document.getElementById('gateWbInput');
    if (qrInput) {
      qrInput.value = '';
      qrInput.focus();
    }
    if (wbInput) wbInput.value = '';
  }

  // ==========================================================================
  // 6. อัปเดตสถิติและภาพถ่ายใบหน้าล่าสุด
  // ==========================================================================
  function updateLastFaceSnapshot(result, facePhotoUrl, meta) {
    const img = document.getElementById('lastFaceImg');
    const nameSpan = document.getElementById('lastFaceAttendee');
    const wbSpan = document.getElementById('lastFaceWristband');
    const timeSpan = document.getElementById('lastFaceTime');
    const metaTag = document.getElementById('faceMetaTag');

    if (img) img.src = facePhotoUrl;
    if (nameSpan) nameSpan.textContent = result.ticket ? result.ticket.attendee_name : 'ไม่พบข้อมูล';
    if (wbSpan) wbSpan.textContent = document.getElementById('gateWbInput')?.value || '-';
    if (timeSpan) timeSpan.textContent = new Date().toLocaleTimeString('th-TH');
    if (metaTag) metaTag.textContent = `${Math.round(meta.byteSize / 1024)}KB (${meta.durationMs}ms)`;
  }

  function updateGateStats() {
    const summary = EventPayDB.getDashboardSummary();
    const statEntered = document.getElementById('statEnteredCount');
    const statExited = document.getElementById('statExitedCount');
    const statIncident = document.getElementById('statIncidentCount');
    const statRemain = document.getElementById('statRemainingCount');

    if (statEntered) statEntered.textContent = `${(summary.attendeesInside || 0).toLocaleString()} คน`;
    if (statExited) statExited.textContent = `${(summary.attendeesExited || 0).toLocaleString()} คน`;
    if (statIncident) statIncident.textContent = `${(summary.totalIncidents || 0).toLocaleString()} ครั้ง`;
    if (statRemain) statRemain.textContent = `${(summary.attendeesRemaining || 0).toLocaleString()} คน`;
  }

  // ==========================================================================
  // 7. ปุ่มทดสอบจำลองเหตุการณ์หน้างานจริง (Quick-Demo Test Buttons)
  // ==========================================================================
  window.fillTestTicket = function (type) {
    const qrInput = document.getElementById('gateQrInput');
    const wbInput = document.getElementById('gateWbInput');

    if (type === 'NEW_VIP') {
      window.toggleGateDirection('IN');
      if (qrInput) qrInput.value = 'EP-TKT-VIP-001-A9F7';
      if (wbInput) wbInput.value = 'WB-ALPHA-01';
    } else if (type === 'NEW_REG') {
      window.toggleGateDirection('IN');
      if (qrInput) qrInput.value = 'EP-TKT-REG-002-B8E3';
      if (wbInput) wbInput.value = 'WB-BETA-02';
    } else if (type === 'EXIT_DEMO') {
      // โหมดออกงาน: สแกนตั๋ว VIP ที่เข้างานแล้ว
      window.toggleGateDirection('OUT');
      const t = EventPayDB.getAll('tickets').find(x => x.qr_code_hash === 'EP-TKT-VIP-001-A9F7');
      if (t && t.gate_status !== 'ENTERED') {
        EventPayDB.update('tickets', t.ticket_id, {
          gate_status: 'ENTERED',
          wristband_id: 'WB-ALPHA-01',
          face_photo_url: generateSimulatedFaceCanvas('EP-TKT-VIP-001-A9F7'),
          entry_count: 1
        });
      }
      if (qrInput) qrInput.value = 'EP-TKT-VIP-001-A9F7';
      if (wbInput) wbInput.value = 'WB-ALPHA-01';
    } else if (type === 'RE_ENTRY_DEMO') {
      // โหมดเข้างานซ้ำ: ต้องสแกนออกมาก่อนเพื่อให้สถานะเป็น EXITED
      window.toggleGateDirection('IN');
      const t = EventPayDB.getAll('tickets').find(x => x.qr_code_hash === 'EP-TKT-VIP-001-A9F7');
      if (t && t.gate_status !== 'EXITED') {
        EventPayDB.update('tickets', t.ticket_id, {
          gate_status: 'EXITED',
          wristband_id: 'WB-ALPHA-01',
          face_photo_url: t.face_photo_url || generateSimulatedFaceCanvas('EP-TKT-VIP-001-A9F7'),
          exit_face_photo_url: generateSimulatedFaceCanvas('EXIT_WB-ALPHA-01'),
          last_exit_at: new Date().toISOString()
        });
      }
      if (qrInput) qrInput.value = 'EP-TKT-VIP-001-A9F7';
      if (wbInput) wbInput.value = 'WB-ALPHA-01';
    } else if (type === 'FRAUD_DUPLICATE') {
      window.toggleGateDirection('IN');
      // บัตร TKT-VIP-004 เข้างานแล้วและผูกกับ WB-9901 แต่เราส่ง WB-WRONG-IMPOSTER-99 เข้าไป
      if (qrInput) qrInput.value = 'EP-TKT-VIP-004-D6C5';
      if (wbInput) wbInput.value = 'WB-WRONG-IMPOSTER-99';
    } else if (type === 'FRAUD_ALREADY_INSIDE') {
      window.toggleGateDirection('IN');
      // ตรวจสอบให้แน่ใจว่าตั๋ว EP-TKT-VIP-001-A9F7 อยู่ในสถานะ ENTERED แล้ว และพยายามสแกนเข้าซ้ำโดยไม่ได้สแกนออก
      const t = EventPayDB.getAll('tickets').find(x => x.qr_code_hash === 'EP-TKT-VIP-001-A9F7');
      if (t && t.gate_status !== 'ENTERED') {
        EventPayDB.update('tickets', t.ticket_id, {
          gate_status: 'ENTERED',
          wristband_id: 'WB-ALPHA-01',
          face_photo_url: generateSimulatedFaceCanvas('EP-TKT-VIP-001-A9F7'),
          entry_count: 1
        });
      }
      if (qrInput) qrInput.value = 'EP-TKT-VIP-001-A9F7';
      if (wbInput) wbInput.value = 'WB-ALPHA-01';
    } else if (type === 'VOID_TICKET') {
      window.toggleGateDirection('IN');
      if (qrInput) qrInput.value = 'EP-TKT-VOID-999-VOID';
      if (wbInput) wbInput.value = 'WB-NEW-99';
    }

    // รันการตรวจสอบทันที
    processGateScan();
  };

  // ==========================================================================
  // 8. กระดานรายชื่อผู้ที่อยู่นอกงานขณะนี้ (Active Outside Attendees Board)
  // ==========================================================================
  window.renderActiveOutsideBoard = function () {
    const container = document.getElementById('outsideAttendeesList');
    const badge = document.getElementById('outsideAttendeesCountBadge');
    if (!container) return;

    const list = typeof EventPayDB.getActiveOutsideAttendees === 'function' ? EventPayDB.getActiveOutsideAttendees() : [];

    if (badge) {
      badge.textContent = `${list.length} คน`;
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 28px 16px; color: #64748b; font-size: 0.95rem; background: rgba(15, 23, 42, 0.4); border-radius: 8px; border: 1px dashed #334155;">
          ✨ ขณะนี้ไม่มีผู้ที่ออกไปนอกงาน (ผู้เข้าชมทุกคนอยู่ในงานคอนเสิร์ต 100%)
        </div>
      `;
      return;
    }

    const now = Date.now();
    container.innerHTML = list.map(item => {
      const exitTime = item.last_exit_at ? new Date(item.last_exit_at) : new Date();
      const timeStr = exitTime.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const diffSec = Math.floor((now - exitTime.getTime()) / 1000);
      let agoStr = 'เพิ่งออก';
      if (diffSec > 60) {
        const diffMin = Math.floor(diffSec / 60);
        agoStr = `${diffMin} นาทีที่แล้ว`;
      } else if (diffSec > 5) {
        agoStr = `${diffSec} วินาทีที่แล้ว`;
      }

      const firstPhoto = item.first_face_photo_url || generateSimulatedFaceCanvas(item.qr_code_hash || item.ticket_id);
      const exitPhoto = item.exit_face_photo_url || generateSimulatedFaceCanvas('EXIT_' + (item.wristband_id || item.ticket_id));

      return `
        <div class="ep-outside-card" id="outside-card-${item.ticket_id}">
          <div style="display: flex; gap: 12px; align-items: center;">
            <div style="display: flex; gap: 6px;">
              <div style="text-align: center;">
                <div style="font-size: 0.65rem; color: #38bdf8; font-weight: 700; margin-bottom: 2px;">เข้าแรก</div>
                <img src="${firstPhoto}" alt="First Face" style="width: 52px; height: 52px; border-radius: 8px; border: 2px solid #38bdf8; object-fit: cover; background: #000; display: block;">
              </div>
              <div style="text-align: center;">
                <div style="font-size: 0.65rem; color: #f59e0b; font-weight: 700; margin-bottom: 2px;">ก้าวออก</div>
                <img src="${exitPhoto}" alt="Exit Face" style="width: 52px; height: 52px; border-radius: 8px; border: 2px solid #f59e0b; object-fit: cover; background: #000; display: block;">
              </div>
            </div>
            <div style="flex: 1; min-width: 0; line-height: 1.4;">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 4px;">
                <strong style="color: #fff; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.customer_name}</strong>
                <span class="ep-badge ep-badge-gold" style="font-size: 0.7rem; padding: 2px 6px;">${item.tier_name}</span>
              </div>
              <div style="font-size: 0.78rem; color: #94a3b8; margin-top: 2px;">
                ริสต์แบนด์: <strong style="color: #38bdf8; font-family: monospace;">${item.wristband_id || '-'}</strong>
              </div>
              <div style="font-size: 0.75rem; color: #64748b;">
                ตั๋ว: <span style="font-family: monospace;">${item.ticket_id}</span>
              </div>
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #1e293b; padding-top: 8px; margin-top: 2px; flex-wrap: wrap; gap: 6px;">
            <div style="font-size: 0.75rem; color: #f59e0b;">
              ⏱️ สแกนออกเมื่อ: <strong>${timeStr}</strong> <span style="color: #94a3b8;">(${agoStr})</span>
            </div>
            <button type="button" class="ep-btn-reentry" onclick="simulateReEntryFromBoard('${item.wristband_id}', '${item.qr_code_hash || item.ticket_id}')" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #fff; border: 1px solid #34d399; font-weight: 800; font-size: 0.78rem; padding: 6px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4); display: inline-flex; align-items: center; gap: 4px;">
              ⚡ สแกนกลับเข้างาน (RE-ENTRY)
            </button>
          </div>
        </div>
      `;
    }).join('');
  };

  window.simulateReEntryFromBoard = function (wristbandId, qrCode) {
    window.toggleGateDirection('IN');
    const qrInput = document.getElementById('gateQrInput');
    const wbInput = document.getElementById('gateWbInput');
    if (qrInput) qrInput.value = qrCode || '';
    if (wbInput) wbInput.value = wristbandId || '';
    processGateScan();
  };

  function updateOutsideBadgeCount() {
    const badge = document.getElementById('outsideAttendeesCountBadge');
    if (!badge) return;
    const cards = document.querySelectorAll('#outsideAttendeesList .ep-outside-card:not(.removing)');
    badge.textContent = `${cards.length} คน`;
  }

  // Helper สำหรับสร้างภาพ Canvas จำลองใบหน้าเมื่อไม่มีกล้องจริง
  function generateSimulatedFaceCanvas(label) {
    if (typeof document === 'undefined') return '';
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, 360, 360);
    grad.addColorStop(0, '#1e293b');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 360, 360);

    // Silhouette icon
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.arc(180, 140, 65, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(180, 340, 110, Math.PI, 0, false);
    ctx.fill();

    // Text tag
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('FACECAP 360x360', 180, 240);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px sans-serif';
    ctx.fillText(label.slice(0, 20), 180, 265);

    return canvas.toDataURL('image/jpeg', 0.75);
  }

  // ==========================================================================
  // 8. ระบบแนบไฟล์รูปภาพ QR Code & ถอดรหัสอัตโนมัติ (QR Image Decoder)
  // ==========================================================================
  window.handleQrFileUpload = function (event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const badge = document.getElementById('qrUploadStatusBadge');
    const text = document.getElementById('qrUploadStatusText');
    if (badge && text) {
      badge.style.display = 'flex';
      badge.style.background = 'rgba(59, 130, 246, 0.15)';
      badge.style.borderColor = '#3b82f6';
      badge.style.color = '#60a5fa';
      text.innerHTML = '⏳ กำลังอ่านและถอดรหัสภาพ QR Code...';
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = async function () {
        let decodedText = null;
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;

        // ด่านที่ 1: ลองใช้ Native BarcodeDetector API ก่อน (Hardware Accelerated บน Chrome/Edge/Android)
        if ('BarcodeDetector' in window) {
          try {
            const detector = new BarcodeDetector({ formats: ['qr_code'] });
            const barcodes = await detector.detect(img);
            if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
              decodedText = barcodes[0].rawValue;
            }
          } catch (err) {
            console.warn('BarcodeDetector warning:', err);
          }
        }

        // ด่านที่ 2: ใช้ jsQR Canvas Engine พร้อมตัวกรอง Smart Quiet-Zone & Solid White Background
        if (!decodedText && typeof jsQR !== 'undefined' && w > 0 && h > 0) {
          // รอบที่ 2.1: เพิ่มขอบขาว Quiet Zone 40px (แก้ปัญหาภาพแคปหน้าจอที่ตัดชิดขอบมาร์กเกอร์)
          try {
            const pad = 40;
            const canvas = document.createElement('canvas');
            canvas.width = w + pad * 2;
            canvas.height = h + pad * 2;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, pad, pad, w, h);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: 'attemptBoth'
            });
            if (code && code.data) {
              decodedText = code.data;
            }
          } catch (err) {
            console.warn('jsQR padded decode warning:', err);
          }

          // รอบที่ 2.2: หากยังไม่พบ ให้ลองสแกนขนาดต้นฉบับตรงๆ (Direct Ratio)
          if (!decodedText) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, w, h);
              ctx.drawImage(img, 0, 0, w, h);
              const imgData = ctx.getImageData(0, 0, w, h);
              const code = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: 'attemptBoth'
              });
              if (code && code.data) {
                decodedText = code.data;
              }
            } catch (err) {
              console.warn('jsQR direct decode warning:', err);
            }
          }
        }

        // ด่านที่ 3: ใช้ ZXing Engine เป็นตัวช่วยสำรองระดับโลก (Fallback MultiFormatReader)
        if (!decodedText && typeof ZXing !== 'undefined') {
          try {
            if (ZXing.BrowserQRCodeReader) {
              const zxReader = new ZXing.BrowserQRCodeReader();
              const result = await zxReader.decodeFromImageElement(img);
              if (result && result.getText()) {
                decodedText = result.getText();
              }
            }
          } catch (zxErr) {
            // ZXing fallback failed silently
          }
        }

        if (decodedText) {
          const cleanCode = decodedText.trim();
          const qrInput = document.getElementById('gateQrInput');
          if (qrInput) qrInput.value = cleanCode;

          if (badge && text) {
            badge.style.display = 'flex';
            badge.style.background = 'rgba(16, 185, 129, 0.15)';
            badge.style.borderColor = '#10b981';
            badge.style.color = '#34d399';
            text.innerHTML = `✓ ถอดรหัสสำเร็จ: <strong style="color: #fff; font-family: monospace;">${cleanCode}</strong>`;
          }

          // ย้ายโฟกัสไปช่องริสต์แบนด์ทันที
          const wbInput = document.getElementById('gateWbInput');
          if (wbInput) {
            wbInput.focus();
            if (!wbInput.value.trim()) {
              wbInput.value = 'WB-REAL-001';
            }
          }
        } else {
          if (badge && text) {
            badge.style.display = 'flex';
            badge.style.background = 'rgba(239, 68, 68, 0.15)';
            badge.style.borderColor = '#ef4444';
            badge.style.color = '#f87171';
            text.innerHTML = '⚠️ ไม่พบ QR Code ในรูปภาพนี้ โปรดเลือกภาพที่มี QR Code ชัดเจน';
          }
          alert('⚠️ ไม่พบข้อมูล QR Code ในรูปภาพที่เลือก กรุณาเลือกรูปภาพที่มี QR Code ชัดเจน หรือภาพแคปหน้าจอ e-Ticket ค่ะ');
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  window.clearQrUpload = function () {
    const badge = document.getElementById('qrUploadStatusBadge');
    if (badge) badge.style.display = 'none';
    const qrInput = document.getElementById('gateQrInput');
    if (qrInput) {
      qrInput.value = '';
      qrInput.focus();
    }
  };

  // ==========================================================================
  // ==========================================================================
  // 9. ระบบเปิดหน้าต่างเลือกตั๋วในระบบ (Quick Ticket Selector Modal พร้อม QR Code คมชัด)
  // ==========================================================================
  window.openQuickTicketModal = function () {
    const modal = document.getElementById('modalQuickTickets');
    const container = document.getElementById('quickTicketsListContainer');
    if (!modal || !container) return;

    const tickets = EventPayDB.getAll('tickets') || [];
    if (tickets.length === 0) {
      container.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 20px;">ยังไม่มีข้อมูลตั๋วในระบบ</div>';
    } else {
      container.innerHTML = tickets.map(t => {
        const isEntered = t.gate_status === 'ENTERED';
        const isVoid = t.is_void;
        let badgeHtml = '<span style="background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 3px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">🟢 ยังไม่เข้างาน</span>';
        if (isVoid) {
          badgeHtml = '<span style="background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 3px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">🔴 บัตรโมฆะ</span>';
        } else if (isEntered) {
          badgeHtml = '<span style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; padding: 3px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">🔵 เข้างานแล้ว</span>';
        }

        const safeAttendee = (t.attendee_name || 'ไม่ระบุชื่อ').replace(/'/g, "\\'");
        const safeTicketId = (t.ticket_id || '').replace(/'/g, "\\'");
        const safeQrHash = (t.qr_code_hash || t.ticket_id || '').replace(/'/g, "\\'");
        const qrBoxId = `quick_modal_qr_${safeTicketId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

        return `
          <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); padding: 10px 14px; border-radius: 6px; gap: 12px; flex-wrap: wrap;">
            <!-- 1. REAL QR CODE THUMBNAIL (ยิงสแกนจากหน้าจอได้จริง 100%) -->
            <div style="display: flex; align-items: center; gap: 12px; min-width: 250px; flex: 1;">
              <div id="${qrBoxId}" title="คลิกเพื่อดู QR ขนาดใหญ่เต็มตา" onclick="viewLargeQrModal('${safeTicketId}', '${safeQrHash}', '${safeAttendee}')" style="width: 68px; height: 68px; background: #ffffff; padding: 4px; border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.45); cursor: pointer; border: 1px solid #e2e8f0;">
                <!-- QR Code Canvas Injected Here -->
              </div>
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <strong style="color: #fff; font-size: 0.95rem;">${t.attendee_name || 'ไม่ระบุชื่อ'}</strong>
                  ${badgeHtml}
                </div>
                <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 3px;">
                  โซน: <span style="color: var(--accent-gold); font-weight: 600;">${t.tier_name || '-'}</span> | 
                  รหัสตั๋ว: <span style="color: var(--accent-cyan); font-family: monospace; font-weight: 700;">${t.ticket_id}</span>
                </div>
                <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px;" title="${safeQrHash}">
                  Hash: ${safeQrHash}
                </div>
              </div>
            </div>

            <!-- 2. ACTION BUTTONS: [เลือกรหัสนี้] + [สแกนเข้าทันที] -->
            <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
              <button type="button" class="ep-nav-btn" onclick="selectQuickTicket('${safeTicketId}', '${safeQrHash}')" style="background: #0284c7; border: 1px solid #38bdf8; color: #fff; padding: 7px 11px; font-size: 0.78rem; border-radius: 4px; cursor: pointer; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;" title="ดึงรหัสลงฟอร์มเพื่อตรวจสอบ">
                👈 เลือกรหัสนี้
              </button>
              <button type="button" class="ep-nav-btn" onclick="quickAutoVerifyTicket('${safeTicketId}', '${safeQrHash}')" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); border: 1px solid #34d399; color: #fff; padding: 7px 11px; font-size: 0.78rem; border-radius: 4px; cursor: pointer; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 2px 6px rgba(16, 185, 129, 0.35);" title="สแกนผ่านประตูทันทีใน 1 คลิกพร้อมถ่ายรูป">
                ⚡ สแกนเข้าทันที
              </button>
            </div>
          </div>
        `;
      }).join('');

      // วาดภาพ QR Code คมชัด (ขนาด 60x60 px) สำหรับตั๋วทุกใบในป๊อปอัป
      setTimeout(() => {
        tickets.forEach(t => {
          const safeTicketId = (t.ticket_id || '').replace(/'/g, "\\'");
          const qrBoxId = `quick_modal_qr_${safeTicketId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          const qrEl = document.getElementById(qrBoxId);
          if (qrEl && typeof QRCode !== 'undefined') {
            qrEl.innerHTML = '';
            try {
              new QRCode(qrEl, {
                text: t.qr_code_hash || t.ticket_id,
                width: 60,
                height: 60,
                colorDark: '#000000',
                colorLight: '#ffffff'
              });
            } catch (err) {
              console.warn('QR Render warning in quick ticket modal:', err);
            }
          }
        });
      }, 50);
    }

    modal.style.display = 'flex';
  };

  window.closeQuickTicketModal = function () {
    const modal = document.getElementById('modalQuickTickets');
    if (modal) modal.style.display = 'none';
  };

  window.selectQuickTicket = function (ticketId, qrCodeHash) {
    const qrInput = document.getElementById('gateQrInput');
    const wbInput = document.getElementById('gateWbInput');
    if (qrInput) qrInput.value = qrCodeHash || ticketId;
    if (wbInput) {
      if (!wbInput.value || wbInput.value.startsWith('WB-AUTO-') || wbInput.value === 'WB-REAL-001') {
        wbInput.value = 'WB-' + ticketId.replace(/[^A-Za-z0-9]/g, '');
      }
      wbInput.focus();
    }
    closeQuickTicketModal();
  };

  // 1-Click Fast Verification: ดึงรหัสแล้วยิงสแกนผ่านประตูทันทีในคลิกเดียว
  window.quickAutoVerifyTicket = function (ticketId, qrCodeHash) {
    const qrInput = document.getElementById('gateQrInput');
    const wbInput = document.getElementById('gateWbInput');
    if (qrInput) qrInput.value = qrCodeHash || ticketId;
    if (wbInput) {
      if (!wbInput.value || wbInput.value.startsWith('WB-AUTO-') || wbInput.value === 'WB-REAL-001') {
        wbInput.value = 'WB-' + ticketId.replace(/[^A-Za-z0-9]/g, '');
      }
    }
    closeQuickTicketModal();

    setTimeout(() => {
      const form = document.getElementById('gateScanForm') || document.getElementById('gateVerifyForm');
      if (form) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          const btn = document.getElementById('btnVerifyGate');
          if (btn) btn.click();
        }
      } else {
        const btn = document.getElementById('btnVerifyGate');
        if (btn) btn.click();
      }
    }, 120);
  };

  // ดูภาพ QR Code ขนาดใหญ่เต็มตาสำหรับยิงสแกนด้วยกล้องมือถือ/ปืนบาร์โค้ด
  window.viewLargeQrModal = function (ticketId, qrCodeHash, attendeeName) {
    let largeModal = document.getElementById('modalLargeQrPreview');
    if (!largeModal) {
      largeModal = document.createElement('div');
      largeModal.id = 'modalLargeQrPreview';
      largeModal.className = 'ep-modal-backdrop';
      largeModal.style.cssText = 'display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.88); z-index: 10000; align-items: center; justify-content: center; padding: 20px;';
      largeModal.innerHTML = `
        <div class="ep-card" style="max-width: 380px; width: 100%; text-align: center; background: #0f172a; border: 1px solid #38bdf8; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.85); padding: 24px; border-radius: 8px;">
          <div style="font-size: 1.15rem; color: #38bdf8; font-weight: 700; margin-bottom: 4px;" id="largeQrAttendee"></div>
          <div style="font-size: 0.85rem; color: #94a3b8; font-family: monospace; margin-bottom: 16px;" id="largeQrTicketId"></div>
          <div style="display: flex; justify-content: center; margin-bottom: 16px;">
            <div id="largeQrBox" style="width: 220px; height: 220px; background: #fff; padding: 10px; border-radius: 8px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.5);"></div>
          </div>
          <div style="font-size: 0.8rem; color: #34d399; margin-bottom: 18px; font-weight: 600;">
            📱 สามารถใช้กล้องมือถือ หรือปืนสแกนเนอร์ ยิงสแกน QR นี้ได้ทันทีค่ะ
          </div>
          <button type="button" class="ep-nav-btn" onclick="document.getElementById('modalLargeQrPreview').style.display='none'" style="background: #334155; color: #fff; border: none; padding: 8px 24px; border-radius: 6px; cursor: pointer; font-weight: 700; width: 100%;">
            ปิดหน้าต่าง
          </button>
        </div>
      `;
      document.body.appendChild(largeModal);
    }

    const nameEl = document.getElementById('largeQrAttendee');
    const idEl = document.getElementById('largeQrTicketId');
    const boxEl = document.getElementById('largeQrBox');
    if (nameEl) nameEl.textContent = attendeeName || 'บัตรเข้างาน';
    if (idEl) idEl.textContent = ticketId;
    if (boxEl && typeof QRCode !== 'undefined') {
      boxEl.innerHTML = '';
      new QRCode(boxEl, {
        text: qrCodeHash || ticketId,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff'
      });
    }
    largeModal.style.display = 'flex';
  };

  // ==========================================================================
  // 10. สถาปัตยกรรม 2 โหมด Kiosk (Dual-Mode: Production LIVE vs Test Simulator)
  //     - โหมด LIVE (Default): หน้าจอสะอาดตา 100% ซ่อนปุ่มจำลอง/แนบรูป เพื่อป้องกันความสับสน
  //     - โหมด TEST: เปิดแผง One-Click Demo และเลือกตั๋วสำหรับซ้อมเสมือนจริง
  // ==========================================================================
  window.currentKioskUiMode = 'LIVE';

  function initKioskMode() {
    let savedMode = 'LIVE';
    try {
      if (typeof window !== 'undefined' && window.location) {
        const urlParams = new URLSearchParams(window.location.search);
        const urlMode = urlParams.get('mode') || (urlParams.get('test') ? 'test' : null);
        if (urlMode && urlMode.toLowerCase() === 'test') {
          savedMode = 'TEST';
        } else {
          const stored = localStorage.getItem('ep_kiosk_ui_mode');
          if (stored === 'TEST') {
            savedMode = 'TEST';
          }
        }
      }
    } catch (e) {
      savedMode = 'LIVE';
    }

    setKioskUiMode(savedMode, false);
  }
  window.initKioskMode = initKioskMode;

  function toggleGateDevMode(forceMode) {
    let nextMode;
    if (typeof forceMode === 'string') {
      nextMode = forceMode.toUpperCase();
    } else if (typeof forceMode === 'boolean') {
      nextMode = forceMode ? 'TEST' : 'LIVE';
    } else {
      nextMode = window.currentKioskUiMode === 'LIVE' ? 'TEST' : 'LIVE';
    }

    setKioskUiMode(nextMode, true);
  }
  window.toggleGateDevMode = toggleGateDevMode;

  function setKioskUiMode(mode, notifyUser) {
    window.currentKioskUiMode = mode === 'TEST' ? 'TEST' : 'LIVE';
    try {
      localStorage.setItem('ep_kiosk_ui_mode', window.currentKioskUiMode);
    } catch (e) {}

    const devQuickActions = document.getElementById('kioskDevQuickActions');
    const devDemoPanel = document.getElementById('kioskDevDemoPanel');
    const toggleBtn = document.getElementById('btnToggleGateDevMode');
    const badgeDot = document.getElementById('gateModeBadgeDot');
    const badgeText = document.getElementById('gateModeBadgeText');
    const dropdownLabel = document.getElementById('dropdownModeLabel');

    if (window.currentKioskUiMode === 'TEST') {
      // แสดงแผงเครื่องมือทดสอบสำหรับช่างเทคนิคและซ้อมหน้างาน
      if (devQuickActions) devQuickActions.style.display = 'flex';
      if (devDemoPanel) devDemoPanel.style.display = 'block';

      if (toggleBtn) {
        toggleBtn.style.background = 'rgba(245, 158, 11, 0.18)';
        toggleBtn.style.borderColor = '#f59e0b';
        toggleBtn.style.color = '#fbbf24';
        toggleBtn.style.boxShadow = '0 2px 8px rgba(245, 158, 11, 0.35)';
      }
      if (badgeDot) {
        badgeDot.style.background = '#f59e0b';
        badgeDot.style.boxShadow = '0 0 8px #f59e0b';
      }
      if (badgeText) {
        badgeText.textContent = '🟡 โหมดทดสอบระบบ (TEST)';
      }
      if (dropdownLabel) {
        dropdownLabel.textContent = 'TEST MODE';
        dropdownLabel.className = 'ep-badge ep-badge-gold';
      }

      if (notifyUser) {
        if (typeof EventPayAudioAlert !== 'undefined' && audioAlert) {
          audioAlert.playChime();
        }
        console.log('🛠️ [Kiosk Dual-Mode] เปิดใช้งานโหมดทดสอบระบบ (Test Simulator Mode) เรียบร้อยค่ะ');
      }
    } else {
      // ซ่อนแผงเครื่องมือทดสอบทั้งหมดเพื่อให้หน้าจอหน้างานจริงสะอาด ไร้จุดสะดุด 100%
      if (devQuickActions) devQuickActions.style.display = 'none';
      if (devDemoPanel) devDemoPanel.style.display = 'none';

      if (toggleBtn) {
        toggleBtn.style.background = 'rgba(16, 185, 129, 0.15)';
        toggleBtn.style.borderColor = '#10b981';
        toggleBtn.style.color = '#34d399';
        toggleBtn.style.boxShadow = '0 2px 6px rgba(16, 185, 129, 0.2)';
      }
      if (badgeDot) {
        badgeDot.style.background = '#10b981';
        badgeDot.style.boxShadow = '0 0 6px #10b981';
      }
      if (badgeText) {
        badgeText.textContent = '🟢 โหมดหน้างานจริง (LIVE)';
      }
      if (dropdownLabel) {
        dropdownLabel.textContent = 'LIVE';
        dropdownLabel.className = 'ep-badge ep-badge-pass';
      }

      if (notifyUser) {
        if (typeof EventPayAudioAlert !== 'undefined' && audioAlert) {
          audioAlert.playChime();
        }
        console.log('🛡️ [Kiosk Dual-Mode] เข้าสู่โหมดหน้างานจริง (Live Production Mode) เรียบร้อยค่ะ');
      }
    }
  }
  window.setKioskUiMode = setKioskUiMode;

})();
