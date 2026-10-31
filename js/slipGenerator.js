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
  if (typeof window !== 'undefined') {
    window.escapeHtml = escapeHtml;
  }
  function _orig_escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  // Helper: Self-Healing Receipt Items Fallback (Thep-Apai Mission 53)
  function getResolvedReceiptItems(order, tickets) {
    let items = [];
    if (order && Array.isArray(order.items) && order.items.length > 0) {
      items = order.items.map(it => ({
        name: it.tier_name || it.name || it.tier_id || 'บัตรคอนเสิร์ต',
        quantity: parseInt(it.quantity || 1, 10),
        unit_price: parseFloat(it.unit_price || 0),
        subtotal: parseFloat(it.subtotal || (it.quantity * it.unit_price) || 0)
      }));
    } else if (tickets && tickets.length > 0) {
      const summary = {};
      tickets.forEach(t => {
        const name = t.tier_name || 'บัตรคอนเสิร์ต';
        if (!summary[name]) {
          summary[name] = { name: name, quantity: 0, tier_id: t.tier_id, unit_price: 0 };
        }
        summary[name].quantity++;
      });
      const allTiers = (typeof EventPayDB !== 'undefined' && EventPayDB.getAll) ? EventPayDB.getAll('ticket_tiers') : [];
      const totalAmount = parseFloat((order && order.total_amount) || 0);
      Object.keys(summary).forEach(k => {
        const s = summary[k];
        const tierObj = allTiers.find(x => x.tier_id === s.tier_id || x.name === s.name);
        s.unit_price = tierObj ? parseFloat(tierObj.price || 0) : (totalAmount && tickets.length > 0 ? (totalAmount / tickets.length) : 0);
        s.subtotal = s.quantity * s.unit_price;
        items.push(s);
      });
    } else if (order && order.tier_id) {
      const allTiers = (typeof EventPayDB !== 'undefined' && EventPayDB.getAll) ? EventPayDB.getAll('ticket_tiers') : [];
      const tierObj = allTiers.find(x => x.tier_id === order.tier_id);
      const totalAmount = parseFloat(order.total_amount || 0);
      const qty = parseInt(order.ticket_count || order.quantity || 1, 10);
      const unitPrice = tierObj ? parseFloat(tierObj.price || 0) : (qty > 0 ? (totalAmount / qty) : totalAmount);
      items.push({
        name: tierObj ? tierObj.name : (order.tier_name || 'บัตรคอนเสิร์ต'),
        quantity: qty,
        unit_price: unitPrice,
        subtotal: totalAmount || (qty * unitPrice)
      });
    } else if (order && order.total_amount) {
      const totalAmount = parseFloat(order.total_amount || 0);
      items.push({
        name: order.tier_name || 'บัตรคอนเสิร์ต',
        quantity: 1,
        unit_price: totalAmount,
        subtotal: totalAmount
      });
    }
    return items;
  }
  if (typeof window !== 'undefined') window.getResolvedReceiptItems = getResolvedReceiptItems;

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
            📲 บันทึก / แชร์รูปภาพ (Share & Save)
          </button>
          <button type="button" onclick="document.getElementById('epSlipMobilePreviewModal').style.display='none'" style="background: #334155; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: 700; border: none; cursor: pointer; width: 100%; font-size: 1rem;">
            ✕ ปิดหน้าต่าง (Close)
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

    filename = filename || 'EventPay_Ticket.png';
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
    const isLineOrInApp = /Line\/|FBAV\/|Instagram|MicroMessenger|musical_ly|BytedanceWebview/i.test(navigator.userAgent);
    const dataUrl = canvas.toDataURL('image/png', 1.0);

    // Save image to mobile window or Web Share
    window._lastGeneratedCanvas = canvas;
    window._lastGeneratedDataUrl = dataUrl;
    window._lastGeneratedFilename = filename;

    // 1. Mobile & In-App Browser: open high-res preview modal with Web Share + Save
    if (isMobile || isLineOrInApp) {
      SlipGenerator.showMobileImageModal(dataUrl, filename);
      // Also attempt direct Web Share API if supported
      if (navigator.share && navigator.canShare && canvas.toBlob) {
        try {
          canvas.toBlob(blob => {
            if (!blob) return;
            const file = new File([blob], filename, { type: 'image/png' });
            if (navigator.canShare({ files: [file] })) {
              navigator.share({
                files: [file],
                title: 'บันทึกรูปภาพ EventPay',
                text: 'รูปภาพเอกสารทางการและตั๋วคอนเสิร์ต EventPay'
              }).catch(() => {});
            }
          }, 'image/png');
        } catch (eShare) {}
      }
      return;
    }

    // 2. Desktop PC: Trigger direct file download
    try {
      if (canvas.toBlob) {
        canvas.toBlob(blob => {
          if (!blob) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            if (a.parentNode) document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
          }, 1000);
        }, 'image/png');
      } else {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { if (a.parentNode) document.body.removeChild(a); }, 1000);
      }
    } catch (e) {
      console.warn('[SlipGenerator] Download fallback:', e);
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
