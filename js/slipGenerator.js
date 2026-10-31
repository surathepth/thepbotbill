/**
 * ============================================================================
 * EVENTPAY SLIP GENERATOR ENGINE (PURE HTML5 CANVAS - HIGH RESOLUTION)
 * ----------------------------------------------------------------------------
 * ออกแบบสำหรับสร้างรูปภาพสลิปใบเสร็จและสลิปตั๋ว QR Code มาตรฐานสากล
 * (Global Standard Fintech/Bank Slip Format for Mobile & Desktop)
 * ขนาดและสัดส่วนตรงกับกระดาษพิมพ์ความร้อน 80 มม. (750px Retina 2x)
 * ============================================================================
 */

(function (window) {
  'use strict';

  const SlipGenerator = {};

  // Helper: ป้องกัน XSS และรองรับการเรนเดอร์ข้อความอย่างปลอดภัย 100%
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Helper: แปลงตัวเลขเป็นคำอ่านบาทไทย
  function numberToThaiBaht(num) {
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

    if (parseInt(decimalPart, 10) === 0) {
      bahtText += 'ถ้วน';
    } else {
      bahtText += readGroup(decimalPart) + 'สตางค์';
    }

    return bahtText;
  }

  // Helper: วาดเส้นประแนวนอน (Dashed Line)
  function drawDashedLine(ctx, x1, y, x2, dashLen = 6, spaceLen = 4) {
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([dashLen, spaceLen]);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    ctx.restore();
  }

  // Helper: วาดกล่องขอบโค้ง (Rounded Rectangle)
  function drawRoundedRect(ctx, x, y, width, height, radius, fillColor, strokeColor, lineWidth = 1) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();

    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    if (strokeColor) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Helper: ดึงภาพ QR Code จากข้อความแฮช (Offscreen Generation)
  function getQRCodeDrawable(hashText, size = 360) {
    return new Promise((resolve) => {
      const container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.left = '-9999px';
      container.style.top = '-9999px';
      document.body.appendChild(container);

      if (typeof QRCode === 'undefined') {
        document.body.removeChild(container);
        resolve(null);
        return;
      }

      new QRCode(container, {
        text: hashText,
        width: size,
        height: size,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: typeof QRCode.CorrectLevel !== 'undefined' ? QRCode.CorrectLevel.M : 0
      });

      setTimeout(() => {
        const img = container.querySelector('img');
        const cvs = container.querySelector('canvas');

        if (img && img.src) {
          const imageObj = new Image();
          imageObj.crossOrigin = 'anonymous';
          imageObj.onload = () => {
            if (container.parentNode) document.body.removeChild(container);
            resolve(imageObj);
          };
          imageObj.onerror = () => {
            if (container.parentNode) document.body.removeChild(container);
            resolve(null);
          };
          imageObj.src = img.src;
        } else if (cvs) {
          if (container.parentNode) document.body.removeChild(container);
          resolve(cvs);
        } else {
          if (container.parentNode) document.body.removeChild(container);
          resolve(null);
        }
      }, 120);
    });
  }

  // ==========================================================================
  // 1. สร้างภาพสลิปใบเสร็จรับเงิน (OFFICIAL RECEIPT SLIP IMAGE)
  // ==========================================================================
  SlipGenerator.generateReceiptSlipCanvas = function (order, payment = {}, tickets = []) {
    return new Promise((resolve) => {
      const scale = 2; // Retina 2x
      const width = 750;

      // รวมกลุ่มรายการบัตร
      const summaryByTier = {};
      tickets.forEach(t => {
        if (!summaryByTier[t.tier_name]) {
          summaryByTier[t.tier_name] = { qty: 0, tier_id: t.tier_id };
        }
        summaryByTier[t.tier_name].qty++;
      });
      const tierNames = Object.keys(summaryByTier);

      // คำนวณความสูงโดยประมาณ
      let estimatedHeight = 780 + (tierNames.length * 36);
      if (order.customer_phone) estimatedHeight += 26;

      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = estimatedHeight * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      // 1. พื้นหลังการ์ดสลิป
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, estimatedHeight);

      // กรอบนอกมาตรฐานสากล
      drawRoundedRect(ctx, 12, 12, width - 24, estimatedHeight - 24, 16, '#ffffff', '#cbd5e1', 2);

      // แถบหัวบนสุดสไตล์สลิปธนาคาร
      drawRoundedRect(ctx, 14, 14, width - 28, 48, 14, '#0f172a', null);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 15px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('EVENTPAY OFFICIAL PAYMENT RECEIPT', width / 2, 44);

      let curY = 96;

      // 2. หัวใบเสร็จรับเงิน 5 บรรทัดตามมาตรฐาน บริษัท ไอซ์ โปรซาวด์ จำกัด
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 22px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('ใบเสร็จรับเงิน', width / 2, curY);

      curY += 32;
      ctx.font = 'bold 26px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText('บริษัท ไอซ์ โปรซาวด์ จำกัด', width / 2, curY);

      curY += 26;
      ctx.fillStyle = '#0284c7';
      ctx.font = 'bold 18px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText('EVENTPAY CONCERT OFFICIAL 2026', width / 2, curY);

      curY += 24;
      ctx.fillStyle = '#475569';
      ctx.font = '15px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText('728 ถ.เพชรเกษม ต.ห้วยจรเข้ อ.เมืองนครปฐม จ.นครปฐม 73000', width / 2, curY);

      curY += 22;
      ctx.fillText('โทรศัพท์: 086-366-4434, 095-761-4224', width / 2, curY);

      curY += 20;
      drawDashedLine(ctx, 36, curY, width - 36);

      // 3. ตารางข้อมูลออเดอร์
      curY += 30;
      ctx.font = '16px "Tahoma", "Segoe UI", sans-serif';

      function drawMetaRow(label, value, isBold = false) {
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'left';
        ctx.font = '16px "Tahoma", "Segoe UI", sans-serif';
        ctx.fillText(label, 42, curY);

        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'right';
        ctx.font = isBold ? 'bold 16px "Tahoma", "Segoe UI", sans-serif' : '16px "Tahoma", "Segoe UI", sans-serif';
        ctx.fillText(value, width - 42, curY);
        curY += 28;
      }

      drawMetaRow('เลขที่ใบเสร็จ:', payment.payment_id || order.order_id || '-', true);
      drawMetaRow('อ้างอิงออเดอร์:', order.order_id || '-', true);
      drawMetaRow('วันที่-เวลา:', new Date(order.created_at || Date.now()).toLocaleString('th-TH'));
      drawMetaRow('ผู้ซื้อ:', order.customer_name || 'ลูกค้าออนไลน์', true);
      if (order.customer_phone) {
        drawMetaRow('เบอร์โทรศัพท์:', order.customer_phone);
      }
      drawMetaRow('ช่องทางชำระเงิน:', order.payment_method === 'CASH' ? 'เงินสด (CASH)' : 'โอนเงิน / QR PROMPTPAY');
      drawMetaRow('เลขอ้างอิงสลิป:', payment.bank_ref || order.bank_ref || 'QR-PROMPTPAY-CONFIRMED');

      curY += 6;
      drawDashedLine(ctx, 36, curY, width - 36);

      // 4. ตารางรายการบัตร
      curY += 28;
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 16px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('รายการบัตร', 42, curY);
      ctx.textAlign = 'center';
      ctx.fillText('จำนวน', width / 2 + 60, curY);
      ctx.textAlign = 'right';
      ctx.fillText('รวม (บาท)', width - 42, curY);

      curY += 10;
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(36, curY);
      ctx.lineTo(width - 36, curY);
      ctx.stroke();

      tierNames.forEach(name => {
        curY += 28;
        const item = summaryByTier[name];
        const tierObj = typeof EventPayDB !== 'undefined' ? EventPayDB.get('ticket_tiers', item.tier_id) : null;
        const price = tierObj ? tierObj.price : 0;
        const subtotal = price * item.qty;

        ctx.fillStyle = '#1e293b';
        ctx.font = '16px "Tahoma", "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(name, 42, curY);

        ctx.textAlign = 'center';
        ctx.fillText(`${item.qty} ใบ`, width / 2 + 60, curY);

        ctx.textAlign = 'right';
        ctx.font = 'bold 16px "Tahoma", "Segoe UI", sans-serif';
        ctx.fillText(`฿${Math.round(subtotal).toLocaleString('th-TH')}`, width - 42, curY);
      });

      curY += 16;
      drawDashedLine(ctx, 36, curY, width - 36);

      // 5. ยอดสุทธิและคำอ่านบาทไทย
      curY += 34;
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 20px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('ยอดรวมสุทธิ (Total Amount):', 42, curY);

      ctx.fillStyle = '#0369a1';
      ctx.font = 'bold 28px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`฿${Math.round(order.total_amount || 0).toLocaleString('th-TH')}`, width - 42, curY);

      curY += 26;
      ctx.fillStyle = '#475569';
      ctx.font = '16px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`(${numberToThaiBaht(order.total_amount || 0)})`, width - 42, curY);

      curY += 20;
      drawDashedLine(ctx, 36, curY, width - 36);

      // 6. ตราประทับชำระเงินเรียบร้อย (Bank/Fintech Seal)
      curY += 28;
      const sealW = 340;
      const sealH = 46;
      const sealX = (width - sealW) / 2;
      drawRoundedRect(ctx, sealX, curY, sealW, sealH, 10, '#ecfdf5', '#10b981', 1.5);

      ctx.fillStyle = '#059669';
      ctx.font = 'bold 18px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✓ PAID / ชำระเงินเรียบร้อยแล้ว', width / 2, curY + 29);

      // 7. ข้อความท้ายสลิป
      curY += sealH + 30;
      ctx.fillStyle = '#64748b';
      ctx.font = '14px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText('ขอบพระคุณที่ร่วมเป็นส่วนหนึ่งของคอนเสิร์ตประวัติศาสตร์', width / 2, curY);

      curY += 22;
      ctx.font = '13px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText('สลิปอิเล็กทรอนิกส์มาตรฐานสากล ออกโดย บริษัท ไอซ์ โปรซาวด์ จำกัด', width / 2, curY);

      resolve(canvas);
    });
  };

  // ==========================================================================
  // 2. สร้างภาพสลิปตั๋ว QR CODE ประจำตัวบุคคล (OFFICIAL TICKET SLIP - 1:1 RATIO)
  // ==========================================================================
  SlipGenerator.generateTicketSlipCanvas = function (ticket, order = {}, index = 1, totalTickets = 1) {
    return new Promise(async (resolve) => {
      const scale = 2; // Retina 2x
      const width = 750;
      const estimatedHeight = 980;

      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = estimatedHeight * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      // 1. พื้นหลังการ์ดสลิป
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, estimatedHeight);

      // กรอบนอกมาตรฐานสากล
      drawRoundedRect(ctx, 12, 12, width - 24, estimatedHeight - 24, 16, '#ffffff', '#cbd5e1', 2);

      // แถบหัวบนสุดสไตล์สลิปตั๋ว
      drawRoundedRect(ctx, 14, 14, width - 28, 48, 14, '#0f172a', null);
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 16px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('EVENTPAY CONCERT 2026 OFFICIAL PASS', width / 2, 44);

      let curY = 96;

      // 2. ข้อมูลหัวตั๋ว (ชื่องาน, โซน, ผู้ถือบัตร)
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 30px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ticket.tier_name || 'บัตรคอนเสิร์ต', width / 2, curY);

      curY += 32;
      ctx.fillStyle = '#1e293b';
      ctx.font = '18px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText(`ผู้ถือบัตร: ${ticket.attendee_name || order.customer_name || 'ผู้เข้าชม'} (ใบที่ ${index}/${totalTickets})`, width / 2, curY);

      // 3. ป้ายเตือนสิทธิ์ 1 ท่าน
      curY += 22;
      const badgeW = 380;
      const badgeH = 40;
      const badgeX = (width - badgeW) / 2;
      drawRoundedRect(ctx, badgeX, curY, badgeW, badgeH, 8, '#fef3c7', '#f59e0b', 1.5);

      ctx.fillStyle = '#b45309';
      ctx.font = 'bold 16px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText('🛡️ 1 คิวอาร์โค้ด ใช้ได้ 1 ท่านเท่านั้น', width / 2, curY + 25);

      // 4. วาดภาพ QR Code ขนาดใหญ่เต็มขอบ Full-Bleed (600x600 px)
      curY += badgeH + 26;
      const qrSize = 600;
      const qrX = (width - qrSize) / 2;

      // กรอบสีขาวรอบ QR Code
      drawRoundedRect(ctx, qrX - 10, curY - 10, qrSize + 20, qrSize + 20, 12, '#ffffff', '#e2e8f0', 1.5);

      const qrDrawable = await getQRCodeDrawable(ticket.qr_code_hash, qrSize);
      if (qrDrawable) {
        ctx.drawImage(qrDrawable, qrX, curY, qrSize, qrSize);
      } else {
        // กรณีดึง QR ไม่ได้ ให้เขียนข้อความระบุ
        ctx.fillStyle = '#0f172a';
        ctx.font = '16px monospace';
        ctx.fillText(ticket.qr_code_hash, width / 2, curY + qrSize / 2);
      }

      curY += qrSize + 24;

      // 5. แฮชโค้ดตัวอักษร Monospace ชัดเจน
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(ticket.qr_code_hash, width / 2, curY);

      curY += 18;
      drawDashedLine(ctx, 36, curY, width - 36);

      // 6. ข้อมูลกำกับตั๋ว (Ticket Metadata Table)
      curY += 32;

      function drawTicketMetaRow(label, value) {
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'left';
        ctx.font = '16px "Tahoma", "Segoe UI", sans-serif';
        ctx.fillText(label, 48, curY);

        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'right';
        ctx.font = 'bold 16px monospace';
        ctx.fillText(value, width - 48, curY);
        curY += 28;
      }

      drawTicketMetaRow('รหัสบัตร (Ticket ID):', ticket.ticket_id || '-');
      drawTicketMetaRow('คำสั่งซื้อ (Order ID):', ticket.order_id || '-');
      drawTicketMetaRow('สถานะประตู (Gate Status):', ticket.gate_status || 'WAITING_ENTRY');
      drawTicketMetaRow('ริสต์แบนด์ (Wristband):', ticket.wristband_id || 'รอผูกหน้าประตู');

      curY += 10;
      drawDashedLine(ctx, 36, curY, width - 36);

      // 7. ข้อแนะนำหน้าประตู (NO payment method text!)
      curY += 28;
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 15px "Tahoma", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('กรุณาแสดงสลิป QR Code นี้ที่จุดคัดกรองทางเข้าเพื่อสแกนและรับริสต์แบนด์', width / 2, curY);

      curY += 24;
      ctx.fillStyle = '#64748b';
      ctx.font = '13px "Tahoma", "Segoe UI", sans-serif';
      ctx.fillText('--- สิ้นสุดบัตรผ่านประตู (1:1 Ticket Pass) ---', width / 2, curY);

      resolve(canvas);
    });
  };

  // ==========================================================================
  // 3. ฟังก์ชันสั่งดาวน์โหลดภาพ (DOWNLOAD HELPERS & UNIVERSAL MOBILE MODAL)
  // ==========================================================================
  SlipGenerator.showMobileImageModal = function (dataUrl, filename) {
    let modal = document.getElementById('epSlipMobilePreviewModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'epSlipMobilePreviewModal';
      modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(15, 23, 42, 0.95); z-index: 99999999;
        display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
        padding: 16px; box-sizing: border-box; overflow-y: auto; backdrop-filter: blur(8px);
      `;
      document.body.appendChild(modal);
    }

    modal.innerHTML = `
      <div style="max-width: 500px; width: 100%; display: flex; flex-direction: column; align-items: center; margin-top: 10px;">
        <div style="width: 100%; display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span style="color: #38bdf8; font-weight: 800; font-size: 1.05rem;">🖼️ สลิปภาพทางการ (สำหรับมือถือ)</span>
          <button type="button" onclick="document.getElementById('epSlipMobilePreviewModal').style.display='none'" style="background: #ef4444; border: none; color: #ffffff; padding: 8px 18px; border-radius: 8px; font-weight: 800; font-size: 0.95rem; cursor: pointer; box-shadow: 0 2px 8px rgba(239, 68, 68, 0.4);">✕ ปิดหน้าต่าง</button>
        </div>

        <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(5, 150, 105, 0.3) 100%); border: 1.5px solid #10b981; border-radius: 12px; padding: 12px 16px; margin-bottom: 14px; width: 100%; text-align: center; box-shadow: 0 4px 18px rgba(16, 185, 129, 0.3);">
          <div style="font-size: 0.95rem; font-weight: 800; color: #34d399; margin-bottom: 4px;">📲 บันทึกลงอัลบั้มรูปในมือถือ:</div>
          <div style="font-size: 0.88rem; color: #fff; line-height: 1.5;">👉 <strong>แตะค้างที่รูปภาพด้านล่าง</strong> แล้วเลือก <strong>"บันทึกรูปภาพ" (Save Image)</strong> ได้ทันทีค่ะ</div>
        </div>

        <img src="${dataUrl}" alt="EventPay Slip" style="width: 100%; max-width: 440px; height: auto; border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.15); margin-bottom: 16px;">

        <div style="display: flex; flex-direction: column; gap: 10px; width: 100%; justify-content: center; margin-bottom: 24px;">
          <button type="button" onclick="window.shareCurrentSlipImage('${filename || 'EventPay_Ticket.png'}')" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; padding: 12px 20px; border-radius: 8px; font-weight: 800; font-size: 0.95rem; text-align: center; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4); display: flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer;">
            🔗 แชร์รูปภาพไปยัง LINE / บันทึกภาพ
          </button>
          <button type="button" onclick="if(window.openBookingPdfViewer){window.openBookingPdfViewer();}else if(window.openLookupPdfViewer){window.openLookupPdfViewer();}else{alert('กรุณาเปิดจากหน้าบุคกิ้งค่ะ');}" style="background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: 800; border: 1px solid #38bdf8; cursor: pointer; width: 100%; font-size: 0.95rem; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);">
            📄 เปิดดูเอกสารรวม (ขนาด 80x80)
          </button>
          <button type="button" onclick="document.getElementById('epSlipMobilePreviewModal').style.display='none'" style="background: #334155; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: 700; border: none; cursor: pointer; width: 100%; font-size: 1rem;">
            ✓ เรียบร้อยแล้ว (ปิด)
          </button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    modal.scrollIntoView({ behavior: 'smooth' });
  };

  // Web Share API Helper สำหรับแชร์รูปภาพสลิปบนมือถือเข้า LINE หรือบันทึกภาพ
  window.shareCurrentSlipImage = async function (filename) {
    const modal = document.getElementById('epSlipMobilePreviewModal');
    const img = modal ? modal.querySelector('img') : null;
    if (!img || !img.src) return;

    if (navigator.share) {
      try {
        const res = await fetch(img.src);
        const blob = await res.blob();
        const file = new File([blob], filename || 'EventPay_Ticket.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: 'ใบเสร็จรับเงิน / ตั๋วคอนเสิร์ต EventPay',
            text: 'หลักฐานทางการ EventPay Official Concert',
            files: [file]
          });
          return;
        }
      } catch (err) {
        if (err && err.name !== 'AbortError') {
          console.warn('[WebShare] share error:', err);
        }
      }
    }
    // คำแนะนำกรณีเบราว์เซอร์ไม่รองรับ Web Share API ให้แตะค้างบันทึกรูป
    alert('👉 คำแนะนำสำหรับมือถือ:\nแตะค้างที่รูปภาพบนหน้าจอ แล้วเลือก "บันทึกรูปภาพ" (Save Image) หรือ "ส่งต่อเข้าแอป LINE" ได้ทันทีค่ะ');
  };

  SlipGenerator.downloadCanvasAsImage = function (canvas, filename) {
    if (!canvas) return;

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
    const isLineOrInApp = /Line\/|FBAV\/|Instagram|MicroMessenger|musical_ly|BytedanceWebview/i.test(navigator.userAgent);
    const dataUrl = canvas.toDataURL('image/png', 1.0);

    // 1. บนมือถือหรือใน In-App Browser (LINE, Facebook) ให้เปิดโมดอลภาพสลิปทันที เพื่อให้แตะค้างบันทึกรูปได้ 100%
    if (isMobile || isLineOrInApp) {
      SlipGenerator.showMobileImageModal(dataUrl, filename);
      // [CRITICAL MOBILE LINE FIX]: หยุดทำงานทันที ไม่ยิง a.click() เพื่อป้องกันเบราว์เซอร์ LINE แสดง Error Toast "ไม่สามารถดาวน์โหลดไฟล์ได้"
      return;
    }

    // 2. สำหรับเบราว์เซอร์ที่รองรับ Web Share API ให้สั่งแชร์ภาพเข้า Photos ได้ในคลิกเดียว
    if (navigator.share && navigator.canShare && canvas.toBlob) {
      try {
        canvas.toBlob(blob => {
          if (!blob) return;
          const file = new File([blob], filename, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            navigator.share({
              files: [file],
              title: 'บันทึกสลิปคอนเสิร์ต EventPay',
              text: 'สลิปหลักฐานทางการคอนเสิร์ต EventPay'
            }).catch(() => {});
          }
        }, 'image/png');
      } catch (eShare) {}
    }

    // 3. ทริกเกอร์ดาวน์โหลดตามปกติ (สำหรับ PC Desktop / ทั่วไป)
    try {
      if (canvas.toBlob) {
        canvas.toBlob(blob => {
          if (!blob) {
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            return;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            if (document.body.contains(a)) document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 2000);
        }, 'image/png');
      } else {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      console.warn('Auto download non-blocking warning:', err);
    }
  };

  /**
   * สร้างภาพ QR Code Data URL จากรหัสตั๋ว
   */
  async function generateQrDataUrl(text, size = 180) {
    if (!text) return '';
    if (typeof QRCode === 'undefined') return '';
    return new Promise((resolve) => {
      const div = document.createElement('div');
      div.style.cssText = 'position: absolute; left: -9999px; top: -9999px; width: ' + size + 'px; height: ' + size + 'px;';
      document.body.appendChild(div);
      try {
        new QRCode(div, {
          text: text,
          width: size,
          height: size,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: (typeof QRCode.CorrectLevel !== 'undefined') ? QRCode.CorrectLevel.M : 0
        });
        setTimeout(() => {
          const canvas = div.querySelector('canvas');
          const img = div.querySelector('img');
          let src = '';
          if (canvas) src = canvas.toDataURL('image/png');
          else if (img) src = img.src;
          if (document.body.contains(div)) document.body.removeChild(div);
          resolve(src);
        }, 80);
      } catch (e) {
        if (document.body.contains(div)) document.body.removeChild(div);
        resolve('');
      }
    });
  }

  /**
   * ระบบเปิดดูเอกสาร PDF รวม และบันทึกเป็น PDF บนมือถือ (Mobile PDF & In-App Viewport)
   */
  SlipGenerator.openPdfViewer = async function (order, payment = {}, tickets = []) {
    if (!order || !order.order_id) {
      alert('ไม่พบข้อมูลคำสั่งซื้อที่จะเปิดดูเอกสาร PDF ค่ะ');
      return;
    }

    // สร้างหรืออัปเดต Print Stylesheet
    let printStyle = document.getElementById('epPdfPrintStyles');
    if (!printStyle) {
      printStyle = document.createElement('style');
      printStyle.id = 'epPdfPrintStyles';
      printStyle.innerHTML = `
        @media print {
          body * { visibility: hidden !important; }
          #epPdfViewerModal, #epPdfViewerModal * { visibility: visible !important; }
          #epPdfViewerModal {
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 100% !important; height: auto !important;
            background: #ffffff !important; padding: 0 !important; margin: 0 !important;
            overflow: visible !important; backdrop-filter: none !important;
          }
          .ep-pdf-no-print { display: none !important; }
          #epPdfPrintableSheet {
            box-shadow: none !important; border-radius: 0 !important;
            padding: 8mm 10mm !important; margin: 0 !important;
            max-width: 100% !important; width: 100% !important;
          }
          .ep-pdf-ticket-page {
            page-break-before: always !important;
            break-before: page !important;
          }
        }
      `;
      document.head.appendChild(printStyle);
    }

    let modal = document.getElementById('epPdfViewerModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'epPdfViewerModal';
      modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(15, 23, 42, 0.95); z-index: 9999999;
        display: none; flex-direction: column; align-items: center;
        overflow-y: auto; backdrop-filter: blur(8px); padding: 12px; box-sizing: border-box;
      `;
      document.body.appendChild(modal);
    } else {
      modal.style.display = 'none';
    }

    try {
      // กำหนดค่าตัวเลขและข้อมูล
      const totalAmount = parseFloat(order.total_amount || 0);
      const formattedDate = new Date(order.created_at || Date.now()).toLocaleString('th-TH', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const cashierText = (order.cashier_id === 'ONLINE_CUSTOMER') ? 'ระบบจองออนไลน์อัตโนมัติ (Online Self-Service)' : (order.cashier_id || 'ONLINE');
      const paymentMethodText = (payment.method || order.payment_method || 'TRANSFER') === 'TRANSFER' ? 'โอนเงินผ่านธนาคาร / พร้อมเพย์ (PromptPay)' : (payment.method || 'เงินสด');
      const bankRefText = order.bank_ref || payment.bank_ref || '-';

      // สร้าง QR Code Image สำหรับตั๋วแต่ละใบ
      const ticketQrImages = [];
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        try {
          const qrDataUrl = await generateQrDataUrl(t.qr_code_hash || t.ticket_id, 200);
          ticketQrImages.push(qrDataUrl);
        } catch (qrErr) {
          console.warn('[SlipGenerator] QR generation fallback for ticket:', t.ticket_id, qrErr);
          ticketQrImages.push('');
        }
      }

    // รายการสินค้า
    const itemsHtml = (order.items || []).map((item, idx) => {
      const tierName = item.tier_name || item.tier_id || 'บัตรคอนเสิร์ต';
      const qty = item.quantity || 1;
      const unitPrice = parseFloat(item.unit_price || (totalAmount / (tickets.length || 1)));
      const subtotal = qty * unitPrice;
      return `
        <tr style="border-bottom: 1px solid #e2e8f0; font-size: 0.9rem;">
          <td style="padding: 10px 8px; text-align: center;">${idx + 1}</td>
          <td style="padding: 10px 8px; font-weight: 700; color: #0f172a;">${escapeHtml(tierName)}</td>
          <td style="padding: 10px 8px; text-align: center;">${qty}</td>
          <td style="padding: 10px 8px; text-align: right;">฿${unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
          <td style="padding: 10px 8px; text-align: right; font-weight: 700;">฿${subtotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        </tr>
      `;
    }).join('');

    // สร้างบัตร e-Ticket แต่ละใบ
    const ticketsHtml = tickets.map((t, idx) => {
      const qrImgSrc = ticketQrImages[idx];
      const tierName = t.tier_name || 'บัตรคอนเสิร์ต';
      return `
        <div class="ep-pdf-ticket-page" style="border: 2px dashed #0284c7; border-radius: 12px; padding: 18px; margin-top: 24px; background: #f8fafc; text-align: center; page-break-inside: avoid;">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #cbd5e1; padding-bottom: 8px; margin-bottom: 12px;">
            <div style="text-align: left;">
              <span style="font-size: 0.8rem; font-weight: 800; color: #0284c7; text-transform: uppercase;">EVENTPAY OFFICIAL E-TICKET PASS</span>
              <div style="font-size: 1.15rem; font-weight: 900; color: #0f172a;">${escapeHtml(tierName)}</div>
            </div>
            <div style="text-align: right;">
              <span style="background: #0284c7; color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 800;">ใบที่ ${idx + 1} / ${tickets.length}</span>
              <div style="font-size: 0.82rem; color: #64748b; font-family: monospace; margin-top: 2px;">${t.ticket_id}</div>
            </div>
          </div>

          <div style="display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 20px; margin: 14px 0;">
            <div style="background: #fff; padding: 10px; border-radius: 10px; border: 1.5px solid #0f172a; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
              ${qrImgSrc ? `<img src="${qrImgSrc}" alt="Ticket QR" style="width: 170px; height: 170px; display: block;">` : `<div style="width:170px;height:170px;display:flex;align-items:center;justify-content:center;font-weight:700;">${t.ticket_id}</div>`}
              <div style="font-size: 0.72rem; color: #64748b; margin-top: 4px; font-weight: 700;">(แตะค้างที่รูปเพื่อบันทึกภาพ)</div>
            </div>

            <div style="text-align: left; max-width: 300px; flex: 1; min-width: 200px; font-size: 0.88rem; line-height: 1.7;">
              <div>👤 <strong>ชื่อผู้ถือบัตร:</strong> <span style="font-size: 0.95rem; font-weight: 800; color: #0f172a;">${escapeHtml(t.attendee_name || order.customer_name || '-')}</span></div>
              <div>📞 <strong>เบอร์โทรศัพท์:</strong> ${escapeHtml(t.attendee_phone || order.customer_phone || '-')}</div>
              <div>🎟️ <strong>โซน / ที่นั่ง:</strong> <span style="font-weight: 700; color: #0369a1;">${t.zone || t.tier_name || 'VIP ZONE'}</span> ${t.seat_number ? `(ที่นั่ง ${t.seat_number})` : ''}</div>
              <div>🏷️ <strong>สถานะริสต์แบนด์:</strong> <span style="color: #059669; font-weight: 700;">${t.wristband_id || 'รอสแกนรับที่หน้าประตู'}</span></div>
              <div style="font-size: 0.78rem; color: #b45309; background: #fef3c7; padding: 4px 8px; border-radius: 6px; margin-top: 6px; border: 1px solid #fde68a;">
                ⚠️ <strong>สิทธิ์ 1 ใบ / 1 คน:</strong> ห้ามส่งต่อให้ผู้อื่น สแกน QR Code เพื่อถ่ายรูปและผูกริสต์แบนด์ที่หน้าประตู
              </div>
            </div>
          </div>

          <div style="font-size: 0.78rem; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; margin-top: 8px;">
            แสดงบัตรคิวอาร์โค้ดนี้ที่ตู้ Kiosk หน้าประตูคอนเสิร์ต | EventPay Security Gate Engine
          </div>
        </div>
      `;
    }).join('');

    modal.innerHTML = `
      <!-- Top Sticky Action Bar (Hidden in Print) -->
      <div class="ep-pdf-no-print" style="max-width: 820px; width: 100%; display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; background: rgba(30, 41, 59, 0.95); padding: 12px 18px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15); position: sticky; top: 0; z-index: 10; box-shadow: 0 6px 20px rgba(0,0,0,0.4);">
        <div style="color: #38bdf8; font-weight: 800; font-size: 1.05rem; display: flex; align-items: center; gap: 8px;">
          <span>📄 เอกสารทางการ PDF & E-Ticket (${order.order_id})</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" onclick="if(/Line\//i.test(navigator.userAgent)){ alert('📱 สำหรับ LINE In-App Browser:\nระบบไม่รองรับคำสั่งพิมพ์โดยตรงค่ะ กรุณาแตะค้างที่รูปภาพ QR Code ด้านล่างเพื่อบันทึกภาพลงเครื่อง หรือเปิดลิงก์ผ่าน Chrome/Safari เพื่อบันทึกเป็นไฟล์ PDF ได้ 100% ค่ะ'); } else { window.print(); }" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; font-weight: 800; border: none; padding: 8px 18px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 0.92rem; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4);">
            🖨️ บันทึกเป็น PDF / พิมพ์
          </button>
          <button type="button" onclick="document.getElementById('epPdfViewerModal').style.display='none'" style="background: rgba(239, 68, 68, 0.2); border: 1px solid #ef4444; color: #fca5a5; font-weight: 700; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 0.92rem;">
            ✕ ปิด
          </button>
        </div>
      </div>

      <!-- Mobile Hint Notice (Hidden in Print) -->
      <div class="ep-pdf-no-print" style="max-width: 820px; width: 100%; background: linear-gradient(135deg, rgba(2, 132, 199, 0.2) 0%, rgba(3, 105, 161, 0.3) 100%); border: 1.5px solid #0284c7; border-radius: 10px; padding: 12px 16px; margin-bottom: 14px; color: #bae6fd; font-size: 0.88rem; line-height: 1.5; text-align: center;">
        📱 <strong>สำหรับผู้ใช้บนมือถือ / แท็บเล็ต / ไอโฟน / ไอแพด:</strong><br>
        สามารถเลื่อนอ่านเอกสารด้านล่างได้ทันที แตะค้างที่รูปภาพ QR Code เพื่อบันทึกลงอัลบั้มรูป หรือกดปุ่ม <strong>"🖨️ บันทึกเป็น PDF / พิมพ์"</strong> ด้านบนเพื่อบันทึกลงในไฟล์ของโทรศัพท์มือถือได้ 100% ค่ะ
      </div>

      <!-- Printable Paper Sheet -->
      <div id="epPdfPrintableSheet" style="max-width: 820px; width: 100%; background: #ffffff; color: #0f172a; border-radius: 12px; padding: 28px; box-sizing: border-box; box-shadow: 0 10px 40px rgba(0,0,0,0.6); margin-bottom: 40px; font-family: 'Tahoma', 'Segoe UI', sans-serif;">
        <!-- Header -->
        <div style="border-bottom: 2px solid #0f172a; padding-bottom: 14px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-size: 1.45rem; font-weight: 900; color: #0f172a; letter-spacing: 0.5px;">บริษัท ไอซ์ โปรซาวด์ จำกัด</div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #0284c7; margin-top: 2px;">EVENTPAY CONCERT OFFICIAL 2026</div>
            <div style="font-size: 0.82rem; color: #64748b; margin-top: 4px;">ระบบจำหน่ายบัตรและบริหารการเงินคอนเสิร์ตมาตรฐานสากล</div>
          </div>
          <div style="text-align: right;">
            <div style="background: #059669; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 0.85rem; font-weight: 800; display: inline-block;">
              ✓ ชำระเงินเรียบร้อยแล้ว (PAID)
            </div>
            <div style="font-size: 0.85rem; color: #64748b; margin-top: 6px;">วันที่: <strong>${formattedDate}</strong></div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a; font-family: monospace;">เลขที่คำสั่งซื้อ: ${order.order_id}</div>
          </div>
        </div>

        <!-- Receipt Section Title (Thep-Apai Strict Rule 7: ต้องเป็นชื่อ "ใบเสร็จรับเงิน" เท่านั้น) -->
        <div style="font-size: 1.15rem; font-weight: 900; color: #0f172a; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
          <span>🧾 ใบเสร็จรับเงิน</span>
        </div>

        <!-- Customer & Order Meta -->
        <div style="background: #f1f5f9; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 0.88rem; line-height: 1.6; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px;">
          <div>👤 <strong>ชื่อผู้สั่งซื้อ:</strong> ${escapeHtml(order.customer_name || '-')}</div>
          <div>📞 <strong>เบอร์โทรศัพท์:</strong> ${escapeHtml(order.customer_phone || '-')}</div>
          <div>💳 <strong>ช่องทางชำระเงิน:</strong> ${escapeHtml(paymentMethodText)}</div>
          <div>🏦 <strong>รหัสอ้างอิงสลิป:</strong> <span style="font-family: monospace; font-weight: 700;">${escapeHtml(bankRefText)}</span></div>
          <div>🖥️ <strong>จุดบริการ:</strong> ${escapeHtml(cashierText)}</div>
          <div>🎟️ <strong>จำนวนบัตรทั้งหมด:</strong> <strong style="color: #0284c7;">${tickets.length} ใบ</strong></div>
        </div>

        <!-- Items Table -->
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <thead>
            <tr style="background: #0f172a; color: #fff; font-size: 0.85rem;">
              <th style="padding: 8px; text-align: center; width: 40px;">#</th>
              <th style="padding: 8px; text-align: left;">ประเภทบัตร</th>
              <th style="padding: 8px; text-align: center; width: 70px;">จำนวน</th>
              <th style="padding: 8px; text-align: right; width: 110px;">ราคา/ใบ</th>
              <th style="padding: 8px; text-align: right; width: 120px;">รวม (บาท)</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
          <tfoot>
            <tr style="background: #e2e8f0; font-weight: 900; font-size: 1.05rem;">
              <td colspan="4" style="padding: 10px 8px; text-align: right;">ยอดชำระสุทธิ (Total Amount):</td>
              <td style="padding: 10px 8px; text-align: right; color: #059669;">฿${totalAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
            </tr>
          </tfoot>
        </table>

        <!-- Tickets Section Title -->
        <div style="font-size: 1.15rem; font-weight: 900; color: #0f172a; margin-top: 26px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          <span>🎟️ บัตรผ่านประตูคอนเสิร์ต e-Ticket Pass (สิทธิ์ 1 ใบ / 1 คน)</span>
        </div>
        <div style="font-size: 0.82rem; color: #64748b; margin-bottom: 12px;">
          โปรดแสดงบัตร QR Code แต่ละใบนี้แก่เจ้าหน้าที่คัดกรอง หรือสแกนที่ตู้ Kiosk หน้าประตูเพื่อถ่ายรูปและรับริสต์แบนด์เข้างาน
        </div>

        <!-- Render All Tickets -->
        ${ticketsHtml}

        <!-- Footer Sign-off -->
        <div style="margin-top: 28px; padding-top: 14px; border-top: 1px solid #cbd5e1; text-align: center; font-size: 0.78rem; color: #64748b; line-height: 1.5;">
          เอกสารนี้ออกโดยระบบบริหารจัดการคอนเสิร์ตอัตโนมัติ EventPay 2026 | พัฒนาและดูแลระบบโดย เทพอภัย & ลิลิน<br>
          หากมีข้อสงสัยเกี่ยวกับบัตรเข้างาน กรุณาติดต่อจุดประชาสัมพันธ์หน้างานคอนเสิร์ต
        </div>
      </div>
    `;

    modal.style.display = 'flex';
    modal.scrollIntoView({ behavior: 'smooth' });
    } catch (pdfErr) {
      console.error('[SlipGenerator.openPdfViewer Error]:', pdfErr);
      if (modal) modal.style.display = 'none';
      alert('เกิดข้อผิดพลาดในการเปิดเอกสาร PDF ค่ะ: ' + (pdfErr.message || pdfErr));
    }
  };

  SlipGenerator.downloadReceiptSlip = async function (order, payment = {}, tickets = []) {
    if (!order) {
      alert('ไม่พบข้อมูลคำสั่งซื้อ');
      return;
    }
    const canvas = await SlipGenerator.generateReceiptSlipCanvas(order, payment, tickets);
    const filename = `EventPay_Receipt_${order.order_id}.png`;
    SlipGenerator.downloadCanvasAsImage(canvas, filename);
  };

  SlipGenerator.downloadTicketSlip = async function (ticket, order = {}, index = 1, totalTickets = 1) {
    if (!ticket) {
      alert('ไม่พบข้อมูลตั๋ว');
      return;
    }
    const canvas = await SlipGenerator.generateTicketSlipCanvas(ticket, order, index, totalTickets);
    const filename = `EventPay_Ticket_${ticket.ticket_id}.png`;
    SlipGenerator.downloadCanvasAsImage(canvas, filename);
  };

  SlipGenerator.downloadAllSlips = async function (order, payment = {}, tickets = []) {
    if (!order) {
      alert('ไม่พบข้อมูลคำสั่งซื้อ');
      return;
    }

    // 1. ดาวน์โหลดสลิปใบเสร็จ
    await SlipGenerator.downloadReceiptSlip(order, payment, tickets);

    // 2. ทยอยดาวน์โหลดตั๋วทุกใบ (เว้นช่วง 250ms เพื่อป้องกันเบราว์เซอร์บล็อกการโหลดหลายไฟล์พร้อมกัน)
    for (let i = 0; i < tickets.length; i++) {
      await new Promise(r => setTimeout(r, 280));
      await SlipGenerator.downloadTicketSlip(tickets[i], order, i + 1, tickets.length);
    }
  };

  window.SlipGenerator = SlipGenerator;

})(window);
