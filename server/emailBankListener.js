/**
 * ==============================================================================
 * EventPay Bank Email Alert Reader (KBank / PromptPay / Multi-Bank TLS IMAP Engine)
 * ==============================================================================
 * สถาปัตยกรรม: Pure Node.js Built-in (tls, crypto) ปราศจาก External Dependencies
 * หน้าที่: ดึงข้อมูลการแจ้งเตือนเงินโอนเข้าบัญชีจาก Gmail (srisarakhams@gmail.com)
 *          รองรับทุกยอดเงินตั้งแต่ 1.00 บาทเป็นต้นไป พร้อมสกัดเลขอ้างอิง Ref 12-25 หลัก
 *          และส่งสัญญาณ Event ให้ Master Server เจน e-Ticket QR Code ทันทีใน 1 วินาที!
 * ==============================================================================
 */

const tls = require('tls');
const fs = require('fs');
const path = require('path');

let activeSocket = null;
let pollTimer = null;
let isRunning = false;
let isProcessing = false;
let config = null;
let paymentCallback = null;
let tagCounter = 1;

/**
 * ฟังก์ชันสกัดข้อมูลยอดเงินและเลข Ref จากข้อความอีเมลธนาคาร
 * รองรับ KBank, SCB, Bangkok Bank, PromptPay และทุกธนาคารไทย
 */
function parseBankEmailText(text, subject = '', from = '') {
  if (!text && !subject) return null;
  const combined = (subject + '\n' + text).replace(/\r\n/g, '\n');

  // ตรวจสอบว่าเป็นอีเมลจากธนาคารหรือแจ้งเตือนเงินเข้าหรือไม่
  const bankKeywords = /(?:กสิกร|kasikorn|kbank|k-speed|scb|ไทยพาณิชย์|กรุงเทพ|bualuang|promptpay|พร้อมเพย์|เงินเข้า|รับโอน|โอนเงิน)/i;
  if (!bankKeywords.test(combined) && !bankKeywords.test(from)) {
    return null;
  }

  // 1. ดึงยอดเงิน (ทุกยอดตั้งแต่ 1.00 บาทขึ้นไป)
  // รูปแบบ เช่น: เงินเข้า 5.00 บาท, +5.00, จำนวนเงิน 5.00 บาท, 1.00 THB, ยอดเงิน 500.00
  let amount = null;
  const amtMatch = combined.match(/(?:\+|เงินเข้า|รับโอนเงิน|จำนวนเงิน|จำนวน|ยอดเงิน|ได้รับเงิน)\s*[:\s]*([0-9,]+(?:\.[0-9]{1,2})?)/i)
                || combined.match(/([0-9,]+\.[0-9]{2})\s*(?:บาท|THB)/i);
  if (amtMatch) {
    const rawAmt = parseFloat(amtMatch[1].replace(/,/g, ''));
    if (!isNaN(rawAmt) && rawAmt >= 1.00) {
      amount = rawAmt;
    }
  }

  // 2. ดึงเลขที่อ้างอิงธุรกรรมธนาคาร (Ref 8-25 หลัก)
  // รูปแบบ เช่น: Ref: 20261027123456, รหัสอ้างอิง: 20261027981245, Transaction ID: 20261027...
  let bank_ref = null;
  const refMatch = combined.match(/(?:Ref(?:\s*No\.?)?|เลขอ้างอิง|รหัสอ้างอิง|รหัสธุรกรรม|Transaction\s*(?:ID|Ref|No\.?)|เลขที่รายการ)\s*[:\s]*([A-Za-z0-9_-]{8,25})/i);
  if (refMatch) {
    bank_ref = refMatch[1].trim();
  }

  // 3. ดึงชื่อผู้โอน (ถ้ามี)
  let sender_name = null;
  const senderMatch = combined.match(/(?:จาก|Sender|โอนจาก)\s*[:\s]*([^\n\r,0-9]+)/i);
  if (senderMatch) {
    sender_name = senderMatch[1].trim();
  }

  // 4. ระบุชื่อธนาคาร
  let bank = 'KBANK';
  if (/scb|ไทยพาณิชย์/i.test(combined) || /scb/i.test(from)) {
    bank = 'SCB';
  } else if (/bualuang|กรุงเทพ|bbl/i.test(combined) || /bangkokbank/i.test(from)) {
    bank = 'BBL';
  } else if (/promptpay|พร้อมเพย์/i.test(combined)) {
    bank = 'PROMPTPAY';
  }

  if (amount !== null && amount >= 1.00) {
    return {
      amount,
      bank_ref: bank_ref || ('REF-' + Date.now()),
      sender_name: sender_name || 'ลูกค้าโอนเงิน',
      bank,
      raw_message: combined
    };
  }

  return null;
}

/**
 * ส่งคำสั่ง IMAP ไปยัง Server อย่างปลอดภัย (Safe Command Execution)
 */
function sendImapCommand(socket, command) {
  const tag = 'A' + String(tagCounter++).padStart(4, '0');
  const cmdLine = `${tag} ${command}\r\n`;
  return new Promise((resolve) => {
    if (!socket || socket.destroyed) {
      return resolve({ tag, raw: '', ok: false });
    }
    let responseData = '';
    const onData = (chunk) => {
      const str = chunk.toString('utf8');
      responseData += str;
      if (responseData.includes(`${tag} OK`) || responseData.includes(`${tag} NO`) || responseData.includes(`${tag} BAD`)) {
        cleanup();
        resolve({ tag, raw: responseData, ok: responseData.includes(`${tag} OK`) });
      }
    };
    const onError = (err) => {
      cleanup();
      resolve({ tag, raw: err.message, ok: false });
    };
    const onClose = () => {
      cleanup();
      resolve({ tag, raw: 'Socket Closed', ok: false });
    };
    function cleanup() {
      try {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      } catch (e) {}
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    try {
      socket.write(cmdLine);
    } catch (e) {
      cleanup();
      resolve({ tag, raw: e.message, ok: false });
    }
  });
}

/**
 * เชื่อมต่อและเริ่มการดักฟัง Email แจ้งเงินเข้า
 */
async function connectAndListen(cfg, onPayment) {
  if (!isRunning) return;

  console.log(`📡 [Email Bank Listener] กำลังเชื่อมต่อ ${cfg.host}:${cfg.port} สำหรับ ${cfg.email}...`);

  try {
    const socket = tls.connect(cfg.port || 993, cfg.host || 'imap.gmail.com', { rejectUnauthorized: false }, async () => {
      console.log(`🟢 [Email Bank Listener] ต่อเชื่อม TLS Port ${cfg.port} สำเร็จ กำลังยืนยันตัวตน...`);
      activeSocket = socket;
    });

    // ดักจับ Error และ Event บน Socket ทันที เพื่อป้องกัน unhandled error event (ECONNRESET) จากการตัดการเชื่อมต่อของ Gmail
    socket.on('error', (err) => {
      console.warn(`⚠️ [Email Bank Listener Socket Error]: ${err.message} (${err.code || 'ERR'})`);
      scheduleReconnect(cfg, onPayment);
    });

    socket.on('close', (hadError) => {
      if (isRunning && (!activeSocket || activeSocket.destroyed)) {
        console.log(`📡 [Email Bank Listener] การเชื่อมต่อ TLS ถูกปิด (hadError: ${hadError})`);
        scheduleReconnect(cfg, onPayment);
      }
    });

    socket.setTimeout(60000); // 60s timeout
    socket.on('timeout', () => {
      console.warn(`⚠️ [Email Bank Listener] Socket Timeout (60s), กำลังรีเฟรชการเชื่อมต่อ...`);
      try { socket.destroy(); } catch (e) {}
    });

    // รอต้อนรับจากเซิร์ฟเวอร์
    await new Promise((resolve) => {
      socket.once('data', (d) => {
        resolve(d.toString());
      });
    });

    // 1. LOGIN
    const cleanPass = (cfg.app_password || '').replace(/\s+/g, '');
    const loginRes = await sendImapCommand(socket, `LOGIN ${cfg.email} ${cleanPass}`);
    if (!loginRes.ok) {
      throw new Error(`LOGIN ล้มเหลว: ${loginRes.raw}`);
    }
    console.log(`✅ [Email Bank Listener] ยืนยันตัวตนสำเร็จ 100%! สแตนด์บายเฝ้าระวังเงินเข้า KBank...`);

    // 2. SELECT INBOX
    const selectRes = await sendImapCommand(socket, 'SELECT INBOX');
    if (!selectRes.ok) {
      throw new Error(`SELECT INBOX ล้มเหลว: ${selectRes.raw}`);
    }

    // 3. เริ่มวงรอบตรวจสอบอีเมลใหม่
    startPollingLoop(socket, cfg, onPayment);

  } catch (err) {
    console.warn(`⚠️ [Email Bank Listener Error]: ${err.message}`);
    scheduleReconnect(cfg, onPayment);
  }
}

/**
 * วงรอบตรวจหาอีเมลใหม่ (Polling Loop)
 */
function startPollingLoop(socket, cfg, onPayment) {
  if (pollTimer) clearInterval(pollTimer);
  const intervalMs = (cfg.check_interval_seconds || 2) * 1000;

  pollTimer = setInterval(async () => {
    if (!isRunning || isProcessing || !activeSocket || activeSocket.destroyed) return;
    isProcessing = true;

    try {
      // ค้นหาเฉพาะอีเมลใหม่วันนี้ (UNSEEN SINCE today) และตรวจสอบเฉพาะ 5 ฉบับล่าสุดเพื่อความเร็วระดับเสี้ยววินาที
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const now = new Date();
      const imapDate = `${now.getDate()}-${months[now.getMonth()]}-${now.getFullYear()}`;
      
      const searchRes = await sendImapCommand(activeSocket, `SEARCH UNSEEN SINCE ${imapDate}`);
      if (searchRes.ok) {
        // รูปแบบผลลัพธ์: * SEARCH 123 124\r\nA0003 OK SEARCH completed
        const match = searchRes.raw.match(/\*\s*SEARCH\s+([0-9\s]+)/i);
        if (match && match[1].trim()) {
          const allMsgIds = match[1].trim().split(/\s+/).filter(Boolean);
          // เอาเฉพาะ 5 ฉบับล่าสุดที่เพิ่งเข้ามา เพื่อให้สแกนได้ใน 0.1 วินาที ไม่ต้องคอยเมลเก่าย้อนหลัง
          const msgIds = allMsgIds.slice(-5);
          console.log(`📩 [Email Bank Listener] พบอีเมลใหม่วันนี้ ${allMsgIds.length} ฉบับ (กำลังตรวจเช็ก ฿ ${msgIds.length} ฉบับล่าสุด)...`);

          for (const id of msgIds) {
            // ดึงเนื้อหาอีเมลและหัวข้อ
            const fetchRes = await sendImapCommand(activeSocket, `FETCH ${id} (BODY[TEXT] BODY[HEADER.FIELDS (SUBJECT FROM DATE)])`);
            if (fetchRes.ok) {
              const parsed = parseBankEmailText(fetchRes.raw);
              if (parsed && parsed.amount >= (cfg.min_amount || 1.00)) {
                console.log(`💰 [Email Bank Listener] ตรวจพบยอดเงินเข้า: ฿${parsed.amount.toFixed(2)} | Ref: ${parsed.bank_ref} | ธนาคาร: ${parsed.bank}`);
                
                // เรียก Callback ส่งสัญญาณเข้า Master Server
                if (typeof onPayment === 'function') {
                  onPayment(parsed);
                }

                // ทำเครื่องหมายว่าอ่านแล้ว (Mark as Seen) เพื่อไม่ให้ประมวลผลซ้ำ
                await sendImapCommand(activeSocket, `STORE ${id} +FLAGS (\\Seen)`);
              }
            }
          }
        }
      }
    } catch (loopErr) {
      console.warn(`⚠️ [Polling Error]: ${loopErr.message}`);
      if (!activeSocket || activeSocket.destroyed) {
        clearInterval(pollTimer);
        scheduleReconnect(cfg, onPayment);
      }
    } finally {
      isProcessing = false;
    }
  }, intervalMs);
}

let reconnectTimer = null;

/**
 * กำหนดการเชื่อมต่อใหม่เมื่อหลุด (Safe Debounced Auto-Reconnect)
 */
function scheduleReconnect(cfg, onPayment) {
  if (!isRunning) return;
  if (reconnectTimer) return;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeSocket && !activeSocket.destroyed) {
    try { activeSocket.destroy(); } catch (e) {}
  }
  activeSocket = null;

  console.log(`🔄 [Email Bank Listener] จะพยายามเชื่อมต่อใหม่ใน 5 วินาที...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isRunning) {
      connectAndListen(cfg, onPayment);
    }
  }, 5000);
}

/**
 * เริ่มทำงาน Email Bank Listener
 */
function startEmailListener(customConfig = null, onPayment = null) {
  if (isRunning) {
    console.log(`ℹ️ [Email Bank Listener] กำลังทำงานอยู่แล้ว`);
    return true;
  }

  // โหลดคอนฟิก
  if (customConfig) {
    config = customConfig;
  } else {
    const configPath = path.join(__dirname, 'bank_email_config.json');
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        console.error(`❌ [Email Bank Listener] โหลด bank_email_config.json ไม่สำเร็จ: ${e.message}`);
        return false;
      }
    } else {
      console.warn(`⚠️ [Email Bank Listener] ไม่พบไฟล์ ${configPath}`);
      return false;
    }
  }

  if (!config || !config.enabled) {
    console.log(`ℹ️ [Email Bank Listener] ปิดการทำงาน (enabled: false)`);
    return false;
  }

  isRunning = true;
  paymentCallback = onPayment;
  connectAndListen(config, onPayment);
  return true;
}

/**
 * หยุดทำงาน Email Bank Listener
 */
function stopEmailListener() {
  isRunning = false;
  if (pollTimer) clearInterval(pollTimer);
  if (activeSocket && !activeSocket.destroyed) {
    try {
      activeSocket.write('A999 LOGOUT\r\n');
      activeSocket.end();
    } catch (e) {}
  }
  activeSocket = null;
  console.log(`🛑 [Email Bank Listener] หยุดการทำงานเรียบร้อยแล้ว`);
}

module.exports = {
  startEmailListener,
  stopEmailListener,
  parseBankEmailText
};
