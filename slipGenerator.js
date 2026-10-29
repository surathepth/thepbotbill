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
      ctx.fillText('*** ใบเสร็จรับเงิน ***', width / 2, curY);

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
      ctx.fillText('จน.', width / 2 + 60, curY);
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

      // 4. วาดภาพ QR Code ขนาดใหญ่เต็มขอบ (360x360 px)
      curY += badgeH + 26;
      const qrSize = 360;
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
  // 3. ฟังก์ชันสั่งดาวน์โหลดภาพ (DOWNLOAD HELPERS)
  // ==========================================================================
  SlipGenerator.downloadCanvasAsImage = function (canvas, filename) {
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL('image/png', 1.0);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download slip error:', err);
      alert('ไม่สามารถดาวน์โหลดภาพสลิปได้: ' + err.message);
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
