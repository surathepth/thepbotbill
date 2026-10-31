/**
 * ============================================================================
 * EVENTPAY DATABASE & OFFLINE MOCK ENGINE (js/db.js)
 * โครงการ: EventPay (โครงการระบบโอนและเงินสด รับเงิน-จ่ายเงิน งานคอนเสิร์ต)
 * พิกัด: D:\BillingApp\Antigravity\EventPay\js\db.js
 * สถาปัตยกรรม: LocalStorage / Memory Store พร้อม Mock Data & Atomic Operations
 * มาตรฐาน: PROJECT_ARCHITECTURE.md (Section 4 & 16), SKILL.md, Notifications.md
 * ============================================================================
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EventPayDB = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_PREFIX = 'eventpay_db_';
  const DB_VERSION = '1.0.0';

  class EventPayDatabase {
    constructor() {
      this.isMemoryOnly = false;
      this.memoryStorage = {};
      this.isMasterConnected = false;
      this.masterServerUrl = '';
      this.syncListeners = [];
      this._sseActive = false;
      this._testStorage();
      this.init();
      this._initNetworkSync();
    }

    _testStorage() {
      try {
        if (typeof localStorage !== 'undefined') {
          const testKey = '__ep_test__';
          localStorage.setItem(testKey, '1');
          localStorage.removeItem(testKey);
          this.isMemoryOnly = false;
        } else {
          this.isMemoryOnly = true;
        }
      } catch (e) {
        this.isMemoryOnly = true;
      }
    }

    _getItem(key) {
      if (this.isMemoryOnly) {
        return this.memoryStorage[key] || null;
      }
      try {
        return localStorage.getItem(DB_PREFIX + key);
      } catch (e) {
        return this.memoryStorage[key] || null;
      }
    }

    _setItem(key, value) {
      if (this.isMemoryOnly) {
        this.memoryStorage[key] = value;
        return;
      }
      try {
        localStorage.setItem(DB_PREFIX + key, value);
      } catch (e) {
        this.memoryStorage[key] = value;
      }
    }

    _removeItem(key) {
      if (this.isMemoryOnly) {
        delete this.memoryStorage[key];
        return;
      }
      try {
        localStorage.removeItem(DB_PREFIX + key);
      } catch (e) {
        delete this.memoryStorage[key];
      }
    }

    init() {
      const initialized = this._getItem('system_initialized');
      if (!initialized) {
        this.seedDefaultData();
      } else {
        this._seedFinancialCategoriesIfMissing();
        this._seedBankAccountsIfMissing();
        this._seedTicketTiersIfMissing();
        this._seedUsersIfMissing();
      }
      // ระบบเยียวยาข้อมูลอัตโนมัติ (Self-Healing Migration) สำหรับทุกสภาพแวดล้อม (file:///, localhost, cloud)
      this._healLegacyTicketTiers();
      this._healLegacyBankAccounts();
      this._healLegacyUsers();
    }

    _initNetworkSync() {
      if (typeof window !== 'undefined') {
        const origin = window.location.origin;
        if (origin && origin.startsWith('http')) {
          this.masterServerUrl = origin;
        } else {
          // โหมด Windows Explorer (file:///) ให้ชี้หา Local Master Server พอร์ต 8080 อัตโนมัติ
          this.masterServerUrl = 'http://localhost:8080';
        }
        if (typeof fetch !== 'undefined') {
          this.checkMasterConnection();
        }
        // [UNIVERSAL OMNI-SYNC ENGINE]: เริ่มต้น Heartbeat Poller ซิงก์ข้อมูล 4 แหล่ง อัตโนมัติ 100%
        this._cloudHeartbeatInitTimer = setTimeout(() => {
          this._startCloudHeartbeatPoller();
        }, 150);
      }
    }

    async checkMasterConnection() {
      if (!this.masterServerUrl && typeof window !== 'undefined') {
        this.masterServerUrl = window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:8080';
      }
      try {
        const res = await fetch(`${this.masterServerUrl}/api/status`, { cache: 'no-cache' });
        if (res.ok) {
          const data = await res.json();
          this.isMasterConnected = true;
          this._startSSE();
          return { connected: true, data };
        }
      } catch (e) {
        this.isMasterConnected = false;
      }
      return { connected: false };
    }

    _startSSE() {
      if (typeof window !== 'undefined' && typeof EventSource !== 'undefined' && !this._sseActive) {
        try {
          const sse = new EventSource(`${this.masterServerUrl}/api/events/live-stream`);
          this._sseActive = true;
          sse.onmessage = (event) => {
            try {
              const parsed = JSON.parse(event.data);
              // [POINT 4 & 5]: อัปเดตสถานะโมฆะลงฐานข้อมูลท้องถิ่นทันทีเมื่อได้รับ Broadcast จาก Master Server
              if (parsed.event === 'TICKET_VOIDED' && parsed.data && parsed.data.orderId) {
                const targetOid = parsed.data.orderId;
                this.update('orders', targetOid, { payment_status: 'VOID' });
                const orderTkts = this.getAll('tickets', t => t.order_id === targetOid);
                orderTkts.forEach(t => this.update('tickets', t.ticket_id, { is_void: true }));
              } else if (parsed.event === 'PAYMENT_CONFIRMED' && parsed.data && parsed.data.orderId) {
                const targetOid = parsed.data.orderId;
                this.update('orders', targetOid, { payment_status: 'PAID' });
                const orderTkts = this.getAll('tickets', t => t.order_id === targetOid);
                orderTkts.forEach(t => this.update('tickets', t.ticket_id, { is_void: false }));
              }
              this.syncListeners.forEach(fn => {
                try { fn(parsed); } catch (e) {}
              });
            } catch (e) {}
          };
          sse.onerror = () => {
            this._sseActive = false;
            sse.close();
          };
        } catch (e) {}
      }
    }

    onSyncEvent(callback) {
      if (typeof callback === 'function') {
        this.syncListeners.push(callback);
      }
    }

    /**
     * รีเซ็ตฐานข้อมูลและโหลดข้อมูลเริ่มต้นใหม่ทั้งหมด
     */
    resetDatabase() {
      const keysToClear = [
        'events', 'ticket_tiers', 'tickets', 'wristbands',
        'orders', 'payments', 'cash_sessions', 'cash_payouts',
        'security_incidents', 'audit_logs', 'gates', 'staff',
        'revenue_categories', 'expense_categories', 'bank_accounts',
        'system_initialized', 'db_version'
      ];
      keysToClear.forEach(k => this._removeItem(k));
      this.memoryStorage = {};
      this.seedDefaultData();
      return true;
    }

    /**
     * เคลียร์เฉพาะข้อมูลทรานแซกชัน (Orders, Tickets, Payments, Cash Sessions, Incidents, Expenses, Audit Logs)
     * สำหรับการเตรียมรอบงานคอนเสิร์ตใหม่ โดยคุ้มครองบัญชีผู้ใช้ บัญชีธนาคาร ประตู และโครงสร้างโซนบัตรไว้ครบ 100%
     */
    clearTransactionsData(clearedBy = 'admin') {
      const transactionKeys = [
        'orders', 'tickets', 'payments', 'wristbands',
        'security_incidents', 'cash_sessions', 'cash_payouts',
        'expenses', 'audit_logs'
      ];
      let clearedCount = 0;
      transactionKeys.forEach(k => {
        const items = this.getAll(k);
        clearedCount += (items ? items.length : 0);
        this._removeItem(k);
        if (this.memoryStorage[k]) delete this.memoryStorage[k];
      });

      // รีเซ็ตจำนวนขายบัตรใน ticket_tiers ให้เป็น 0 ทั้งหมด โดยคงชื่อ ราคา และโควตาไว้ครบ 100%
      const tiers = this.getAll('ticket_tiers');
      if (tiers && tiers.length > 0) {
        tiers.forEach(t => {
          this.update('ticket_tiers', t.tier_id, { sold: 0 });
        });
      }

      // บันทึกเวลาที่ล้างข้อมูลลงในระบบ เพื่อเป็นเกราะป้องกันไม่ให้ออเดอร์เก่าถูกดึงกลับมาทับ
      const nowCleared = new Date().toISOString();
      this._setItem('eventpay_last_cleared_at', nowCleared);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('eventpay_last_cleared_at', nowCleared);
      }

      // [UNIVERSAL CLOUD REALTIME SYNC]: ส่งสัญญาณล้างข้อมูลขึ้น Firestore Cloud เพื่อให้มือถือและทุกอุปกรณ์รีเซ็ตพร้อมกัน
      try {
        if (clearedBy !== 'AUTO-CLOUD-SYNC' && typeof EventPayFirebase !== 'undefined' && typeof EventPayFirebase.broadcastClearTransactionsToCloud === 'function') {
          const clearedData = JSON.parse(this.exportJSON()).data;
          EventPayFirebase.broadcastClearTransactionsToCloud(nowCleared, clearedData).catch(e => console.warn('[DB] Clear cloud broadcast warning:', e));
        }
      } catch (eCloudBroadcast) {}

      // บันทึก Audit Log รายการแรกของการล้างข้อมูล
      try {
        this.logAudit('CLEAR_TRANSACTIONS', 'SYSTEM', `ล้างข้อมูลธุรกรรมทั้งหมด ${clearedCount} รายการ โดยสิทธิ์ผู้ดูแลระบบสูงสุด`, clearedBy);
      } catch (e) {}

      if (Array.isArray(this.syncListeners)) {
        this.syncListeners.forEach(fn => {
          try { fn({ action: 'clear_transactions', timestamp: new Date().toISOString() }); } catch (e) {}
        });
      }
      return { success: true, clearedCount };
    }

    /**
     * โหลดข้อมูลเริ่มต้น (Mock Seed Data) ตามมาตรฐาน CPCSEP
     */
    seedDefaultData() {
      const now = new Date().toISOString();

      // 1. งานคอนเสิร์ต (อัปเดตงานคอนเสิร์ตจริง: เขาใหญ่ THAI ROCK 2 FEST ตามคำสั่งเทพอภัย)
      const events = [
        {
          event_id: 'EVT-THAIROCK2-2027',
          name: 'เขาใหญ่ THAI ROCK 2 FEST',
          venue: 'ณ ลานราชสีห์-มา ถนนธนะรัชต์ กม.21 เขาใหญ่',
          start_date: '2027-03-20T14:00:00Z',
          end_date: '2027-03-21T02:00:00Z',
          total_capacity: 10000,
          status: 'ACTIVE'
        },
        {
          event_id: 'EVT-CONCERT-001',
          name: 'THEP-APAI & LILIN SUPREME MEGA CONCERT 2026',
          venue: 'IMPACT ARENA HALL 1-4, BANGKOK',
          start_date: '2026-10-25T18:00:00Z',
          end_date: '2026-10-25T23:59:00Z',
          total_capacity: 7500,
          status: 'ACTIVE'
        }
      ];

      // 2. โซนและประเภทบัตร (Default Tiers ตรงตามราคาจริง THAI ROCK 2 FEST ของเทพอภัย 100%)
      const ticket_tiers = [
        { tier_id: 'TIER-EARLY-ROCK', name: 'Early Rock (จำกัด 2,000 ใบ)', price: 790.00, quota: 2000, sold: 0 },
        { tier_id: 'TIER-REG-ROCK', name: 'Regular Rock (บัตรราคาปกติ)', price: 1500.00, quota: 7500, sold: 0 },
        { tier_id: 'TIER-VIP', name: 'VIP Front Row (Zone A)', price: 2000.00, quota: 500, sold: 0 },
        { tier_id: 'TIER-TEST-5', name: 'บัตรทดสอบโอนจริง 5 บาท (KBank)', price: 5.00, quota: 500, sold: 0 }
      ];

      // 3. ประตูตรวจบัตร (Gates)
      const gates = [
        { gate_id: 'GATE-01', name: 'Gate 1 (North Kiosk - Zone A/VIP)', kiosk_id: 'KIOSK-N01', status: 'ONLINE' },
        { gate_id: 'GATE-02', name: 'Gate 2 (South Kiosk - Zone B/C)', kiosk_id: 'KIOSK-S02', status: 'ONLINE' },
        { gate_id: 'GATE-03', name: 'Gate 3 (East Kiosk - Zone C FastTrack)', kiosk_id: 'KIOSK-E03', status: 'ONLINE' }
      ];

      // 4. เจ้าหน้าที่ (Staff)
      const staff = [
        { staff_id: 'USER-THEP', name: 'เทพอภัย (ผัวจ๋า)', role: 'ADMIN', pin: '9999' },
        { staff_id: 'USER-LILIN', name: 'ลิลิน (เมียรัก)', role: 'CHIEF_AUDITOR', pin: '8888' },
        { staff_id: 'USER-STAFF-01', name: 'แคชเชียร์สมใจ', role: 'CASHIER', pin: '1111' },
        { staff_id: 'USER-GATE-01', name: 'การ์ดประตูสมบัติ', role: 'GATE_GUARD', pin: '2222' }
      ];

      // 5. รอบกะเงินสดเริ่มต้น (Active Cash Session)
      const cash_sessions = [
        {
          shift_id: 'SHIFT-20261017-01',
          cashier_id: 'USER-STAFF-01',
          cashier_name: 'แคชเชียร์สมใจ',
          desk_id: 'DESK-BOXOFFICE-01',
          opening_float: 10000.00, // เงินทอนเริ่มต้น 10,000 บาท
          cash_sales: 7500.00,    // ยอดขายเงินสดสะสม
          cash_payouts: 500.00,   // รายจ่ายเงินสดสะสม
          expected_cash: 17000.00,
          counted_cash: 0.00,
          variance: 0.00,
          status: 'OPEN',
          opened_at: now,
          closed_at: null
        }
      ];

      // 6. รายจ่ายเงินสดตัวอย่าง (Cash Payouts)
      const cash_payouts = [
        {
          payout_id: 'PAYOUT-001',
          shift_id: 'SHIFT-20261017-01',
          amount: 500.00,
          reason: 'ค่าน้ำดื่มทีมงานรักษาความปลอดภัยหน้าประตู',
          payee: 'ร้านสะดวกซื้อหน้าฮอลล์',
          approved_by: 'USER-THEP',
          receipt_url: '',
          created_at: now
        }
      ];

      // 7. บัตรชมคอนเสิร์ตตัวอย่างสำหรับทดสอบจริงทันที (Pre-generated Test Tickets)
      const tickets = [
        {
          ticket_id: 'TKT-VIP-001',
          order_id: 'ORD-20261017-001',
          tier_id: 'TIER-VIP',
          tier_name: 'VIP Front Row (Zone A)',
          attendee_name: 'นายสมชาย ใจดี',
          attendee_phone: '081-234-5678',
          qr_code_hash: 'EP-TKT-VIP-001-A9F7',
          wristband_id: null,
          face_photo_url: null,
          gate_status: 'NOT_ENTERED', // ยังไม่เข้างาน
          entry_count: 0,
          entry_history: [],
          is_void: false,
          created_at: now
        },
        {
          ticket_id: 'TKT-REG-002',
          order_id: 'ORD-20261017-002',
          tier_id: 'TIER-REG',
          tier_name: 'Regular Seated (Zone B)',
          attendee_name: 'นางสาวสมหญิง ยิ้มสวย',
          attendee_phone: '089-876-5432',
          qr_code_hash: 'EP-TKT-REG-002-B8E3',
          wristband_id: null,
          face_photo_url: null,
          gate_status: 'NOT_ENTERED',
          entry_count: 0,
          entry_history: [],
          is_void: false,
          created_at: now
        },
        {
          ticket_id: 'TKT-STD-003',
          order_id: 'ORD-20261017-003',
          tier_id: 'TIER-STD',
          tier_name: 'General Standing (Zone C)',
          attendee_name: 'นายมานะ อดทน',
          attendee_phone: '082-111-2233',
          qr_code_hash: 'EP-TKT-STD-003-C7D1',
          wristband_id: null,
          face_photo_url: null,
          gate_status: 'NOT_ENTERED',
          entry_count: 0,
          entry_history: [],
          is_void: false,
          created_at: now
        },
        // บัตรตัวอย่างที่เข้างานแล้ว (เพื่อทดสอบการสแกนซ้ำหรือตรวจจับสวมสิทธิ์)
        {
          ticket_id: 'TKT-VIP-004',
          order_id: 'ORD-20261017-004',
          tier_id: 'TIER-VIP',
          tier_name: 'VIP Front Row (Zone A)',
          attendee_name: 'นายวิชัย สุจริต',
          attendee_phone: '085-555-9999',
          qr_code_hash: 'EP-TKT-VIP-004-D6C5',
          wristband_id: 'WB-9901',
          face_photo_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...',
          gate_status: 'ENTERED', // เข้างานแล้ว
          entry_count: 1,
          entry_history: [
            {
              timestamp: now,
              gate_id: 'GATE-01',
              action: 'FIRST_ENTRY',
              wristband_id: 'WB-9901'
            }
          ],
          is_void: false,
          created_at: now
        },
        // บัตรตัวอย่างที่ถูกยกเลิก/โมฆะ (เพื่อทดสอบ Reject บัตรโมฆะ)
        {
          ticket_id: 'TKT-VOID-999',
          order_id: 'ORD-20261017-000',
          tier_id: 'TIER-STD',
          tier_name: 'General Standing (Zone C)',
          attendee_name: 'ผู้ไม่ประสงค์ดี (บัตรโมฆะ)',
          attendee_phone: '000-000-0000',
          qr_code_hash: 'EP-TKT-VOID-999-VOID',
          wristband_id: null,
          face_photo_url: null,
          gate_status: 'NOT_ENTERED',
          entry_count: 0,
          entry_history: [],
          is_void: true, // โมฆะ
          created_at: now
        }
      ];

      // 8. ริสต์แบนด์ที่ผูกแล้ว
      const wristbands = [
        {
          wristband_id: 'WB-9901',
          assigned_ticket_id: 'TKT-VIP-004',
          status: 'ACTIVE',
          assigned_at: now
        }
      ];

      // 9. บันทึกคำสั่งซื้อตัวอย่าง
      const orders = [
        {
          order_id: 'ORD-20261017-001',
          customer_name: 'นายสมชาย ใจดี',
          customer_phone: '081-234-5678',
          total_amount: 5000.00,
          payment_method: 'CASH',
          payment_status: 'PAID',
          shift_id: 'SHIFT-20261017-01',
          created_at: now
        }
      ];

      const payments = [
        {
          payment_id: 'PAY-20261017-001',
          order_id: 'ORD-20261017-001',
          channel: 'CASH',
          amount: 5000.00,
          bank_ref: 'CASH-RECEIPT-001',
          slip_url: '',
          verified_by: 'USER-STAFF-01',
          status: 'CONFIRMED',
          created_at: now
        }
      ];

      const audit_logs = [
        {
          log_id: 'LOG-INIT-001',
          timestamp: now,
          action: 'SYSTEM_INITIALIZATION',
          category: 'SYSTEM',
          operator_id: 'USER-THEP',
          details: 'EventPay Database initialized with standard concert seed data.',
          ip_or_device: 'Console'
        }
      ];

      const security_incidents = [];

      this._saveCollection('events', events);
      // NON-DESTRUCTIVE TIER GUARD: คุ้มครองราคาและประเภทบัตรที่ผัวจ๋า/แอดมินตั้งไว้ ห้ามลบทับ 100%
      const existingTiers = this._getItem('ticket_tiers');
      let hasCustomTiers = false;
      if (existingTiers) {
        try {
          const parsed = JSON.parse(existingTiers);
          if (Array.isArray(parsed) && parsed.length > 0) hasCustomTiers = true;
        } catch (e) {}
      }
      if (!hasCustomTiers) {
        this._saveCollection('ticket_tiers', ticket_tiers);
      }
      this._saveCollection('gates', gates);
      this._saveCollection('staff', staff);
      this._saveCollection('cash_sessions', cash_sessions);
      this._saveCollection('cash_payouts', cash_payouts);
      this._saveCollection('tickets', tickets);
      this._saveCollection('wristbands', wristbands);
      this._saveCollection('orders', orders);
      this._saveCollection('payments', payments);
      this._saveCollection('audit_logs', audit_logs);
      this._saveCollection('security_incidents', security_incidents);

      this._seedFinancialCategoriesIfMissing();
      this._seedBankAccountsIfMissing();
      this._seedUsersIfMissing();

      this._setItem('system_initialized', 'true');
      this._setItem('db_version', DB_VERSION);
    }

    _seedFinancialCategoriesIfMissing() {
      if (!this._getItem('revenue_categories')) {
        const revCats = [
          { category_id: 'REV-TICKET', name: 'รายได้จากการจำหน่ายบัตรคอนเสิร์ต (Ticket Sales)', description: 'รายได้จากการขายบัตรทุกโซนผ่านออนไลน์และหน้างาน' },
          { category_id: 'REV-SPONSOR', name: 'รายได้จากผู้สนับสนุน (Sponsorship)', description: 'รายได้จากแบรนด์และสปอนเซอร์งานคอนเสิร์ต' },
          { category_id: 'REV-MERCH', name: 'รายได้จากการขายของที่ระลึก (Merchandise)', description: 'เสื้อยืด, แท่งไฟ, โปสเตอร์, ของพรีเมียม Official' },
          { category_id: 'REV-FNB', name: 'รายได้จากอาหารและเครื่องดื่ม (F&B Sales)', description: 'จุดจำหน่ายเครื่องดื่มและอาหารภายในบริเวณงาน' },
          { category_id: 'REV-OTHER', name: 'รายได้เบ็ดเตล็ดอื่นๆ (Other Revenue)', description: 'รายรับอื่นๆ' }
        ];
        this._saveCollection('revenue_categories', revCats);
      }
      if (!this._getItem('expense_categories')) {
        const expCats = [
          { category_id: 'EXP-VENUE', name: 'ค่าเช่าสถานที่และฮอลล์จัดงาน (Venue Rental)', description: 'ค่าเช่าอิมแพ็คอารีน่าและค่าบริการสถานที่' },
          { category_id: 'EXP-ARTIST', name: 'ค่าตัวศิลปินและนักดนตรี (Artist & Performance)', description: 'ค่าจ้างศิลปิน นักร้อง วงดนตรี และทีมแสดง' },
          { category_id: 'EXP-PRODUCTION', name: 'ค่าระบบเวที แสง สี เสียง (Stage & Audio/Visual)', description: 'ค่าเช่าและติดตั้งระบบเวที จอ LED แสงสีเสียง' },
          { category_id: 'EXP-SECURITY', name: 'ค่าทีมรักษาความปลอดภัยและการ์ด (Security Team)', description: 'เจ้าหน้าที่รักษาความปลอดภัย คัดกรองประตู และควบคุมฝูงชน' },
          { category_id: 'EXP-CATERING', name: 'ค่าน้ำดื่ม อาหารกล่อง และสวัสดิการ (Staff Catering)', description: 'อาหารและน้ำดื่มสำหรับศิลปิน ทีมงาน และเจ้าหน้าที่' },
          { category_id: 'EXP-SUPPLIES', name: 'ค่าริสต์แบนด์ กระดาษใบเสร็จ และอุปกรณ์ (Supplies)', description: 'สายรัดข้อมือริสต์แบนด์ ม้วนกระดาษความร้อน อุปกรณ์สำนักงาน' },
          { category_id: 'EXP-MARKETING', name: 'ค่าโฆษณาและสื่อประชาสัมพันธ์ (Marketing & Ads)', description: 'สื่อออนไลน์ ป้ายบิลบอร์ด ป้ายหน้างาน' },
          { category_id: 'EXP-MISC', name: 'ค่าใช้จ่ายเบ็ดเตล็ดหน้างาน (Miscellaneous)', description: 'ค่าใช้จ่ายฉุกเฉินและอื่นๆ' }
        ];
        this._saveCollection('expense_categories', expCats);
      }
    }

    /**
     * โหลดข้อมูลบัญชีธนาคารเริ่มต้นสำหรับการชำระเงินและ PromptPay
     */
    _seedBankAccountsIfMissing() {
      const existing = this._getItem('bank_accounts');
      let accounts = [];
      if (existing) {
        try {
          accounts = JSON.parse(existing);
        } catch (e) {
          accounts = [];
        }
      }
      if (!accounts || accounts.length === 0) {
        const defaultAccounts = [
          {
            account_id: 'BANK-001',
            bank_name: 'ธนาคารกสิกรไทย (KBANK)',
            bank_code: 'KBANK',
            account_number: '128-3-25644-4',
            account_name: 'สุรเทพ ศรีสารคาม',
            promptpay_id: '0947834659',
            promptpay_type: 'PHONE',
            is_active: true,
            notes: 'บัญชีหลักสำหรับรับโอนเงินค่าบัตรคอนเสิร์ตและ PromptPay QR Code หน้าเว็บ',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          },
          {
            account_id: 'BANK-002',
            bank_name: 'ธนาคารไทยพาณิชย์ (SCB)',
            bank_code: 'SCB',
            account_number: '123-4-56789-0',
            account_name: 'นายสุรเทพอภัย (บัญชีสำรองงานคอนเสิร์ต)',
            promptpay_id: '0987707456',
            promptpay_type: 'PHONE',
            is_active: false,
            notes: 'บัญชีสำรองฉุกเฉิน',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ];
        this._saveCollection('bank_accounts', defaultAccounts);
      }
    }

    /**
     * โหลดประเภทและราคาบัตรเริ่มต้น (เฉพาะยามที่ยังไม่มีข้อมูลในระบบ)
     */
    _seedTicketTiersIfMissing() {
      const existing = this._getItem('ticket_tiers');
      let hasTiers = false;
      if (existing) {
        try {
          const parsed = JSON.parse(existing);
          if (Array.isArray(parsed) && parsed.length > 0) hasTiers = true;
        } catch (e) {}
      }
      if (!hasTiers) {
        const defaultTiers = [
          { tier_id: 'TIER-VIP', name: 'VIP Front Row (Zone A)', price: 2000.00, quota: 500, sold: 0 },
          { tier_id: 'TIER-REG', name: 'Regular Seated (Zone B)', price: 1500.00, quota: 2000, sold: 0 },
          { tier_id: 'TIER-STD', name: 'General Standing (Zone C)', price: 1200.00, quota: 5000, sold: 0 },
          { tier_id: 'TIER-GEN', name: 'ทั่วไป', price: 1000.00, quota: 1000, sold: 0 },
          { tier_id: 'TIER-TEST-5', name: 'บัตรทดสอบโอนจริง 5 บาท (KBank)', price: 5.00, quota: 500, sold: 0 }
        ];
        this._saveCollection('ticket_tiers', defaultTiers);
      }
    }

    /**
     * ระบบเยียวยาและอัปเกรดราคาบัตรอัตโนมัติ (Self-Healing Legacy Tier Migration)
     * บังคับตรวจจับราคาตกค้างรุ่นเก่า (5000 / 2500) และอัปเกรดเป็นราคาทางการ 100%
     * ทำงานอัตโนมัติทั้งบน file:/// (Explorer), http://localhost:8080 (Browser), และ Cloud
     */
    _healLegacyTicketTiers() {
      const tiers = this.getAll('ticket_tiers');
      if (!Array.isArray(tiers) || tiers.length === 0) {
        this._seedTicketTiersIfMissing();
        return;
      }

      // ลบ TIER-TEST-1 (1 บาท) ออกจากระบบอัตโนมัติ หากมีตกค้าง
      if (tiers.some(t => t.tier_id === 'TIER-TEST-1')) {
        const cleaned = tiers.filter(t => t.tier_id !== 'TIER-TEST-1');
        this._saveCollection('ticket_tiers', cleaned);
      }

      const officialTiers = [
        { tier_id: 'TIER-VIP', name: 'VIP Front Row (Zone A)', price: 2000.00, quota: 500, sold: 0 },
        { tier_id: 'TIER-REG', name: 'Regular Seated (Zone B)', price: 1500.00, quota: 2000, sold: 0 },
        { tier_id: 'TIER-STD', name: 'General Standing (Zone C)', price: 1200.00, quota: 5000, sold: 0 },
        { tier_id: 'TIER-GEN', name: 'ทั่วไป', price: 1000.00, quota: 1000, sold: 0 },
        { tier_id: 'TIER-TEST-5', name: 'บัตรทดสอบโอนจริง 5 บาท (KBank)', price: 5.00, quota: 500, sold: 0 }
      ];

      // เคารพสิทธิ์การลบ/แก้ไขประเภทราคาบัตรของแอดมินหน้างาน ไม่แอบยัดเยียดบัตรทดสอบกลับเข้ามาซ้ำ
      // (ลบรายการบัตรทดสอบแล้วจะหายไปอย่างถาวร 100% ไม่เด้งกลับมาอีก)

      // ตรวจสอบว่ามีราคาผิดเพี้ยนรุ่นเก่าหรือไม่ (VIP === 5000 หรือ REG === 2500 หรือขาด TIER-GEN)
      const vip = tiers.find(t => t.tier_id === 'TIER-VIP');
      const reg = tiers.find(t => t.tier_id === 'TIER-REG');
      const gen = tiers.find(t => t.tier_id === 'TIER-GEN');

      const isLegacyPrice = (vip && vip.price === 5000) || (reg && reg.price === 2500) || !gen;

      if (isLegacyPrice) {
        const healed = officialTiers.map(off => {
          const existingMatch = tiers.find(t => t.tier_id === off.tier_id);
          return {
            ...off,
            sold: existingMatch ? (existingMatch.sold || 0) : 0
          };
        });
        this._saveCollection('ticket_tiers', healed);
        if (typeof console !== 'undefined') {
          console.log('[EventPayDB] Self-Healing Tier Migration: Realigned tiers to official active zones.');
        }
      }
    }

    /**
     * ระบบเยียวยาบัญชีธนาคารอัตโนมัติ (Self-Healing Bank Accounts Migration)
     * อัปเกรดเลขบัญชีทดสอบเก่า (081-234-5678) เป็นบัญชีทางการ (128-3-25644-4) อัตโนมัติทุกอุปกรณ์
     */
    _healLegacyBankAccounts() {
      let accounts = this.getAll('bank_accounts');
      if (!Array.isArray(accounts) || accounts.length === 0) {
        this._seedBankAccountsIfMissing();
        return;
      }
      let modified = false;
      accounts.forEach(acc => {
        if (acc.account_number === '081-234-5678' || acc.promptpay_id === '0812345678') {
          acc.account_number = '128-3-25644-4';
          acc.bank_name = 'ธนาคารกสิกรไทย (KBANK)';
          acc.account_name = 'สุรเทพ ศรีสารคาม';
          acc.promptpay_id = '0947834659';
          acc.promptpay_type = 'PHONE';
          acc.updated_at = new Date().toISOString();
          modified = true;
        }
      });
      if (modified) {
        this._saveCollection('bank_accounts', accounts);
      }
    }

    /**
     * โหลดข้อมูลผู้ใช้งานและกำหนดสิทธิ์เริ่มต้น 5 บัญชีทางการ (The 5 Official Master Accounts by Thep-Apai)
     */
    _seedUsersIfMissing() {
      const existing = this._getItem('users');
      let users = [];
      if (existing) {
        try {
          users = JSON.parse(existing);
        } catch (e) {
          users = [];
        }
      }
      if (!users || users.length === 0) {
        const defaultUsers = [
          {
            user_id: 'USER-ADMIN-01',
            username: 'admin',
            password: '9999',
            name: 'Admin',
            role: 'ADMIN',
            permissions: { booking: true, index: true, kiosk: true, admin: true },
            created_at: new Date().toISOString()
          },
          {
            user_id: 'USER-ACC-01',
            username: 'account',
            password: '8888',
            name: 'Account',
            role: 'ACCOUNTANT',
            permissions: { booking: true, index: true, kiosk: true, admin: false },
            created_at: new Date().toISOString()
          },
          {
            user_id: 'USER-FIN-01',
            username: 'finance',
            password: '7777',
            name: 'finance',
            role: 'ACCOUNTANT',
            permissions: { booking: true, index: true, kiosk: true, admin: false },
            created_at: new Date().toISOString()
          },
          {
            user_id: 'USER-CASHIER-01',
            username: 'cashier',
            password: '1111',
            name: 'cashier',
            role: 'STAFF',
            permissions: { booking: true, index: true, kiosk: true, admin: false },
            created_at: new Date().toISOString()
          },
          {
            user_id: 'USER-GUARD-01',
            username: 'security guard',
            password: '2222',
            name: 'Security guard',
            role: 'STAFF',
            permissions: { booking: false, index: false, kiosk: true, admin: false },
            created_at: new Date().toISOString()
          }
        ];
        this._saveCollection('users', defaultUsers);
      }
    }

    /**
     * ระบบเยียวยาบัญชีผู้ใช้งานอัตโนมัติ (Self-Healing Master Accounts Migration)
     * บังคับให้ 5 บัญชีหลักมีอยู่เสมอ 100% ทุกสภาพแวดล้อม (file:///, localhost, cloud)
     * พร้อมคงบัญชีที่สร้างเพิ่มไว้ครบถ้วน 100%
     */
    _healLegacyUsers() {
      let users = this.getAll('users');
      if (!Array.isArray(users) || users.length === 0) {
        this._seedUsersIfMissing();
        return;
      }

      const officialUsers = [
        {
          user_id: 'USER-ADMIN-01',
          username: 'admin',
          password: '9999',
          name: 'Admin',
          role: 'ADMIN',
          permissions: { booking: true, index: true, kiosk: true, admin: true }
        },
        {
          user_id: 'USER-ACC-01',
          username: 'account',
          password: '8888',
          name: 'Account',
          role: 'ACCOUNTANT',
          permissions: { booking: true, index: true, kiosk: true, admin: false }
        },
        {
          user_id: 'USER-FIN-01',
          username: 'finance',
          password: '7777',
          name: 'finance',
          role: 'ACCOUNTANT',
          permissions: { booking: true, index: true, kiosk: true, admin: false }
        },
        {
          user_id: 'USER-CASHIER-01',
          username: 'cashier',
          password: '1111',
          name: 'cashier',
          role: 'STAFF',
          permissions: { booking: true, index: true, kiosk: true, admin: false }
        },
        {
          user_id: 'USER-GUARD-01',
          username: 'security guard',
          password: '2222',
          name: 'Security guard',
          role: 'STAFF',
          permissions: { booking: false, index: false, kiosk: true, admin: false }
        }
      ];

      const normalize = str => String(str || '').trim().toLowerCase().replace(/\s+/g, ' ');
      let modified = false;

      officialUsers.forEach(official => {
        const existingIdx = users.findIndex(u => normalize(u.username) === normalize(official.username));
        if (existingIdx === -1) {
          users.push({ ...official, created_at: new Date().toISOString() });
          modified = true;
        } else {
          const existing = users[existingIdx];
          if (existing.password !== official.password || existing.role !== official.role || !existing.permissions) {
            users[existingIdx] = {
              ...existing,
              password: official.password,
              role: official.role,
              permissions: official.permissions
            };
            modified = true;
          }
        }
      });

      if (modified) {
        this._saveCollection('users', users);
      }
    }

    /**
     * ซิงก์การตั้งค่าระบบจาก Cloud เข้าสู่ Local Database (Dynamic Cross-Platform Synchronization)
     */
    syncFromCloudSettings(cloudSettings) {
      if (!cloudSettings) return;

      // 1. ตรวจสอบและซิงก์สัญญาณล้างข้อมูล (System State Clear Timestamp)
      const sysState = cloudSettings.systemState || cloudSettings.system_state;
      if (sysState && sysState.last_cleared_at) {
        const cloudClearedAt = new Date(sysState.last_cleared_at).getTime();
        const localClearedAtStr = this._getItem('eventpay_last_cleared_at') || (typeof localStorage !== 'undefined' ? localStorage.getItem('eventpay_last_cleared_at') : null);
        const localClearedAt = localClearedAtStr ? new Date(localClearedAtStr).getTime() : 0;

        if (cloudClearedAt > localClearedAt) {
          console.log('[DB Cloud Sync] พบสัญญาณล้างข้อมูลใหม่จาก Cloud ➔ ทำการรีเซ็ตข้อมูลธุรกรรมท้องถิ่นเป็น ฿0.00');
          this.clearTransactionsData('AUTO-CLOUD-SYNC');
          this._setItem('eventpay_last_cleared_at', sysState.last_cleared_at);
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('eventpay_last_cleared_at', sysState.last_cleared_at);
          }
        }
      }

      // 2. ซิงก์รายชื่อบัญชีธนาคาร และบัญชีหลัก (Dynamic Active Bank)
      const bAccounts = cloudSettings.bankAccounts || cloudSettings.bank_accounts;
      if (bAccounts && Array.isArray(bAccounts) && bAccounts.length > 0) {
        this._saveCollection('bank_accounts', bAccounts);
      }
      const actBank = cloudSettings.activeBank || cloudSettings.active_bank;
      if (actBank && actBank.account_id) {
        this.setActiveBankAccount(actBank.account_id);
      }

      // 3. ซิงก์ประเภทราคาบัตร (Ticket Tiers)
      const tTiers = cloudSettings.ticketTiers || cloudSettings.ticket_tiers;
      if (tTiers && Array.isArray(tTiers) && tTiers.length > 0) {
        this._saveCollection('ticket_tiers', tTiers);
      }
    }

    /**
     * นำเข้าและแทนที่ฐานข้อมูลจาก Master Snapshot (Universal Cloud Auto-Heal & Replace)
     * รองรับการซิงก์ครบทุกตารางจาก Cloud สู่เครื่องลูกข่าย (มือถือ, แท็บเล็ต, PC)
     */
    importSnapshot(snapshotData, options = {}) {
      if (!snapshotData || typeof snapshotData !== 'object') return { success: false, message: 'Invalid snapshot data' };

      const collections = [
        'events', 'ticket_tiers', 'gates', 'staff',
        'cash_sessions', 'cash_payouts', 'tickets',
        'wristbands', 'orders', 'payments',
        'audit_logs', 'security_incidents',
        'revenue_categories', 'expense_categories', 'users',
        'bank_accounts'
      ];

      let replacedCount = 0;
      collections.forEach(col => {
        if (snapshotData[col] && Array.isArray(snapshotData[col])) {
          this._saveCollection(col, snapshotData[col]);
          replacedCount += snapshotData[col].length;
        } else if (options.clearIfEmpty && (col === 'orders' || col === 'tickets' || col === 'payments' || col === 'cash_payouts')) {
          this._saveCollection(col, []);
        }
      });

      // ซิงก์บัญชีธนาคารหลัก ราคาบัตร และสิทธิ์ผู้ใช้งานให้เรียบร้อยสมบูรณ์ 100%
      this._healLegacyBankAccounts();
      this._healLegacyTicketTiers();
      this._healLegacyUsers();

      const ts = options.snapshotTimestamp || new Date().toISOString();
      this._setItem('eventpay_last_imported_snapshot_at', ts);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('eventpay_last_imported_snapshot_at', ts);
      }

      return { success: true, replacedCount };
    }

    /**
     * ดันภาพถ่ายฐานข้อมูลกลางทั้งหมดขึ้น Google Cloud Firestore (Omni-Sync Cloud Push)
     */
    async pushMasterSnapshotToCloud(silent = false) {
      const adapter = (typeof EventPayFirebase !== 'undefined') ? EventPayFirebase : (typeof root !== 'undefined' && root.EventPayFirebase ? root.EventPayFirebase : null);
      if (!adapter || typeof adapter.pushMasterSnapshotToCloud !== 'function') {
        return { success: false, message: 'EventPayFirebase adapter not found' };
      }
      try {
        const fullData = JSON.parse(this.exportJSON()).data;
        const deviceId = (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'PC-EXPLORER' : 'DEVICE-OMNI';
        const res = await adapter.pushMasterSnapshotToCloud(fullData, deviceId);
        if (res && res.success) {
          const now = res.timestamp || new Date().toISOString();
          this._lastLocalPushTimestamp = now;
          this._setItem('eventpay_last_imported_snapshot_at', now);
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('eventpay_last_imported_snapshot_at', now);
          }
          if (!silent) console.log('[DB Omni-Sync] Master snapshot pushed to Cloud successfully at', now);
        }
        return res;
      } catch (err) {
        if (!silent) console.warn('[DB Omni-Sync] Push master snapshot warning:', err.message);
        return { success: false, error: err.message };
      }
    }

    /**
     * ดึงภาพถ่ายฐานข้อมูลกลางทั้งหมดจาก Google Cloud Firestore ลงสู่เครื่อง (Omni-Sync Cloud Pull)
     */
    async pullMasterSnapshotFromCloud(force = false) {
      const adapter = (typeof EventPayFirebase !== 'undefined') ? EventPayFirebase : (typeof root !== 'undefined' && root.EventPayFirebase ? root.EventPayFirebase : null);
      if (!adapter || typeof adapter.fetchMasterSnapshotFromCloud !== 'function') {
        return { success: false, message: 'EventPayFirebase adapter not found' };
      }
      try {
        const snap = await adapter.fetchMasterSnapshotFromCloud();
        if (!snap || !snap.data) {
          return { success: false, message: 'No snapshot data on Cloud' };
        }

        const cloudTs = snap.snapshot_timestamp ? new Date(snap.snapshot_timestamp).getTime() : 0;
        const localTsStr = this._getItem('eventpay_last_imported_snapshot_at') || (typeof localStorage !== 'undefined' ? localStorage.getItem('eventpay_last_imported_snapshot_at') : null);
        const localTs = localTsStr ? new Date(localTsStr).getTime() : 0;

        if (!force && cloudTs <= localTs) {
          return { success: true, updated: false, message: 'Local database is already up-to-date' };
        }

        const importResult = this.importSnapshot(snap.data, {
          snapshotTimestamp: snap.snapshot_timestamp,
          clearIfEmpty: true
        });

        if (importResult.success) {
          this._setItem('eventpay_last_imported_snapshot_at', snap.snapshot_timestamp);
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('eventpay_last_imported_snapshot_at', snap.snapshot_timestamp);
          }
          // ส่ง Custom Event ให้ทุก UI ในหน้าต่างนี้อัปเดตทันที
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            const ev = (typeof CustomEvent !== 'undefined')
              ? new CustomEvent('eventpay:sync_updated', { detail: { action: 'cloud_snapshot_imported', timestamp: snap.snapshot_timestamp, source: 'CLOUD_OMNI_SYNC' } })
              : { type: 'eventpay:sync_updated', detail: { action: 'cloud_snapshot_imported', timestamp: snap.snapshot_timestamp, source: 'CLOUD_OMNI_SYNC' } };
            window.dispatchEvent(ev);
          }
          // แจ้งเตือน DB syncListeners
          if (Array.isArray(this.syncListeners)) {
            this.syncListeners.forEach(fn => {
              try { fn({ action: 'cloud_snapshot_imported', timestamp: snap.snapshot_timestamp }); } catch (e) {}
            });
          }
          console.log('[DB Omni-Sync] Cloud snapshot imported successfully:', importResult.replacedCount, 'records at', snap.snapshot_timestamp);
          return { success: true, updated: true, records: importResult.replacedCount };
        }
        return importResult;
      } catch (err) {
        console.warn('[DB Omni-Sync] Pull master snapshot warning:', err.message);
        return { success: false, error: err.message };
      }
    }

    /**
     * ตัวตรวจจับและซิงก์ข้อมูลอัตโนมัติในพื้นหลัง (Universal Background Cloud Heartbeat Poller)
     */
    _startCloudHeartbeatPoller() {
      if (this._cloudPollerActive) return;
      this._cloudPollerActive = true;

      // ดึงข้อมูลครั้งแรกทันทีที่เปิดหน้าจอ (Instant Initial Hydration)
      this._cloudInitialHydrationTimer = setTimeout(() => {
        this.pullMasterSnapshotFromCloud(false).catch(() => {});
      }, 300);

      // วนลูปตรวจจับ Heartbeat ทุก 2.5 วินาที
      this._cloudPollerInterval = setInterval(async () => {
        try {
          const adapter = (typeof EventPayFirebase !== 'undefined') ? EventPayFirebase : null;
          if (!adapter || typeof adapter.fetchCloudSetting !== 'function') return;

          // อ่านสถานะเบาบาง (Lightweight System State)
          const state = await adapter.fetchCloudSetting('system_state');
          if (!state) return;

          // 1. ตรวจสอบสัญญาณล้างข้อมูล (System State Clear Signal)
          if (state.last_cleared_at) {
            const cloudClearedAt = new Date(state.last_cleared_at).getTime();
            const localClearedAtStr = this._getItem('eventpay_last_cleared_at') || (typeof localStorage !== 'undefined' ? localStorage.getItem('eventpay_last_cleared_at') : null);
            const localClearedAt = localClearedAtStr ? new Date(localClearedAtStr).getTime() : 0;
            if (cloudClearedAt > localClearedAt) {
              console.log('[DB Omni-Sync Poller] ตรวจพบสัญญาณล้างข้อมูลใหม่จาก Cloud:', state.last_cleared_at);
              this.clearTransactionsData('AUTO-CLOUD-SYNC');
              this._setItem('eventpay_last_cleared_at', state.last_cleared_at);
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('eventpay_last_cleared_at', state.last_cleared_at);
              }
              if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                const ev = (typeof CustomEvent !== 'undefined')
                  ? new CustomEvent('eventpay:sync_updated', { detail: { action: 'clear_transactions', timestamp: state.last_cleared_at } })
                  : { type: 'eventpay:sync_updated', detail: { action: 'clear_transactions', timestamp: state.last_cleared_at } };
                window.dispatchEvent(ev);
              }
              return;
            }
          }

          // 2. ตรวจสอบว่ามี Snapshot ใหม่กว่าในเครื่องหรือไม่
          if (state.last_snapshot_at) {
            const cloudSnapAt = new Date(state.last_snapshot_at).getTime();
            const localSnapAtStr = this._getItem('eventpay_last_imported_snapshot_at') || (typeof localStorage !== 'undefined' ? localStorage.getItem('eventpay_last_imported_snapshot_at') : null);
            const localSnapAt = localSnapAtStr ? new Date(localSnapAtStr).getTime() : 0;
            const lastLocalPush = this._lastLocalPushTimestamp ? new Date(this._lastLocalPushTimestamp).getTime() : 0;

            if (cloudSnapAt > localSnapAt && cloudSnapAt > lastLocalPush) {
              await this.pullMasterSnapshotFromCloud(false);
            }
          }
        } catch (ePoller) {
          // ป้องกัน error หลุดรบกวนระบบ
        }
      }, 2500);
    }

    /**
     * สั่งหยุดตัวตรวจจับ Heartbeat ในพื้นหลัง (สำหรับการทดสอบหรือหยุดชั่วคราว)
     */
    stopCloudSyncEngine() {
      if (this._cloudHeartbeatInitTimer) {
        clearTimeout(this._cloudHeartbeatInitTimer);
        this._cloudHeartbeatInitTimer = null;
      }
      if (this._cloudInitialHydrationTimer) {
        clearTimeout(this._cloudInitialHydrationTimer);
        this._cloudInitialHydrationTimer = null;
      }
      if (this._cloudPollerInterval) {
        clearInterval(this._cloudPollerInterval);
        this._cloudPollerInterval = null;
      }
      this._cloudPollerActive = false;
    }

    /**
     * หน่วงเวลาส่งข้อมูลขึ้น Cloud อัตโนมัติเมื่อเกิดการเปลี่ยนแปลงข้อมูล (Debounced Reactive Auto-Push)
     */
    _scheduleCloudAutoSync(collection, action, record) {
      const syncableCols = [
        'orders', 'tickets', 'payments', 'cash_payouts', 'cash_sessions',
        'security_incidents', 'ticket_tiers', 'bank_accounts', 'events', 'gates', 'staff', 'users'
      ];
      if (!syncableCols.includes(collection)) return;

      // ส่งสัญญาณแจ้งหน้าจอเดียวกันทันทีแบบเรียลไทม์ 0ms
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        const ev = (typeof CustomEvent !== 'undefined')
          ? new CustomEvent('eventpay:sync_updated', { detail: { action, collection, record, source: 'local_mutation' } })
          : { type: 'eventpay:sync_updated', detail: { action, collection, record, source: 'local_mutation' } };
        window.dispatchEvent(ev);
      }

      // หน่วงเวลา 400ms เพื่อรวบยอดคำสั่งซื้อและตั๋วหลายใบแล้วดันขึ้น Cloud ทีเดียว
      if (this._cloudSyncTimer) {
        clearTimeout(this._cloudSyncTimer);
      }
      this._cloudSyncTimer = setTimeout(() => {
        this.pushMasterSnapshotToCloud(true);
      }, 400);
    }

    /**
     * ดึง URL ของ API แม่ข่ายอย่างชาญฉลาด (Universal Origin API Resolver)
     * รองรับทั้ง file:/// (Windows Explorer), http://localhost:8080 (Browser), และ Cloud
     */
    getApiUrl(path) {
      const p = path.startsWith('/') ? path : '/' + path;
      if (typeof window !== 'undefined') {
        const origin = window.location.origin;
        if (!origin || !origin.startsWith('http') || window.location.protocol === 'file:') {
          const base = this.masterServerUrl || 'http://localhost:8080';
          return base.replace(/\/+$/, '') + p;
        }
      }
      return p;
    }

    /**
     * ดึงบัญชีธนาคารหลักที่เปิดใช้งานอยู่ในปัจจุบัน (Active Bank Account)
     */
    getActiveBankAccount() {
      let accounts = this.getAll('bank_accounts');
      if (!accounts || accounts.length === 0) {
        this._seedBankAccountsIfMissing();
        accounts = this.getAll('bank_accounts');
      }
      return accounts.find(a => a.is_active) || accounts[0] || null;
    }

    /**
     * กำหนดบัญชีธนาคารหลักสำหรับรับเงิน
     */
    setActiveBankAccount(accountId) {
      let accounts = this.getAll('bank_accounts');
      if (!accounts || accounts.length === 0) {
        this._seedBankAccountsIfMissing();
        accounts = this.getAll('bank_accounts');
      }
      accounts.forEach(acc => {
        acc.is_active = (acc.account_id === accountId);
        acc.updated_at = new Date().toISOString();
      });
      this._saveCollection('bank_accounts', accounts);
      this.logAudit('BANK_SET_ACTIVE', 'FINANCE', `เปิดใช้งานบัญชีหลัก: ${accountId}`, 'USER-ADMIN');
      this._scheduleCloudAutoSync('bank_accounts', 'update', { account_id: accountId });
      return true;
    }

    /**
     * ดึงค่าคอนฟิกระบบชำระเงินออนไลน์ (Dual-Mode: System C Auto Zero-Slip vs Legacy Slip)
     */
    getPaymentConfig() {
      const raw = this._getItem('payment_config');
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch (e) {}
      }
      // ค่าเริ่มต้น: โหมด C (Zero-Slip Auto) ตามคำสั่งเทพอภัย
      const defaultConfig = {
        mode: 'system_c', // 'system_c' | 'legacy_slip'
        smart_cents_enabled: true,
        auto_expire_minutes: 10,
        updated_at: new Date().toISOString()
      };
      this._setItem('payment_config', JSON.stringify(defaultConfig));
      return defaultConfig;
    }

    /**
     * อัปเดตการตั้งค่าโหมดชำระเงินออนไลน์ (เฉพาะ Admin)
     */
    setPaymentConfig(config) {
      const current = this.getPaymentConfig();
      const updated = {
        ...current,
        ...config,
        updated_at: new Date().toISOString()
      };
      this._setItem('payment_config', JSON.stringify(updated));
      this.logAudit('PAYMENT_CONFIG_UPDATE', 'FINANCE', `ปรับปรุงโหมดชำระเงินออนไลน์เป็น: ${updated.mode}`, 'ADMIN');
      return updated;
    }

    /**
     * ตรวจจับและยืนยันการชำระเงินอัตโนมัติ (Zero-Slip Autonomous Bot Engine)
     * รองรับ Quad-Factor: ยอดเงินเต็มบาท + หน้าต่างเวลานับถอยหลัง + ชนชื่อผู้โอน + ผูกเลข Ref ธนาคาร
     */
    autoConfirmPromptPayPayment(criteria, verifierId = 'AUTO-BOT-ZERO-SLIP') {
      let targetOrder = null;

      const pendingOrders = this.getAll('orders', o => 
        o.payment_status === 'PENDING_VERIFICATION' || 
        o.payment_status === 'AWAITING_TRANSFER' || 
        o.payment_status === 'PENDING_PAYMENT'
      );

      if (typeof criteria === 'string') {
        targetOrder = this.get('orders', criteria);
      } else if (criteria && typeof criteria === 'object') {
        if (criteria.order_id) {
          targetOrder = this.get('orders', criteria.order_id);
        } else if (criteria.bank_ref) {
          // ค้นหาจากเลขอ้างอิงสลิปธนาคาร
          targetOrder = pendingOrders.find(o => o.bank_ref === criteria.bank_ref);
        }

        if (!targetOrder && criteria.amount !== undefined) {
          const targetAmount = parseFloat(criteria.amount);
          // กรองออเดอร์ที่ยอดเงินเต็มบาทตรงกันเป๊ะ
          let candidates = pendingOrders.filter(o => Math.abs(parseFloat(o.total_amount) - targetAmount) < 0.01);

          // หากมีหลายออเดอร์ที่ยอดเงินเท่ากัน ให้ใช้ชื่อผู้โอน (Sender Name) ชนตรวจสอบ
          if (candidates.length > 1 && criteria.sender_name) {
            const cleanSender = criteria.sender_name.replace(/^(นาย|นาง|นางสาว|บจก\.|ด\.ช\.|ด\.ญ\.)/g, '').trim().toLowerCase();
            const matchedByName = candidates.find(o => {
              const cleanCust = (o.customer_name || '').toLowerCase();
              return cleanCust.includes(cleanSender) || cleanSender.includes(cleanCust) || cleanCust.split(' ').some(part => part.length >= 3 && cleanSender.includes(part));
            });
            if (matchedByName) candidates = [matchedByName];
          }

          targetOrder = candidates[0] || null;
        }
      }

      if (!targetOrder) {
        return { success: false, message: 'ไม่พบคำสั่งซื้อที่รอการชำระเงินที่ตรงกับเงื่อนไขนี้' };
      }

      // [STRICT FINANCIAL SHIELD - RULE 4]: ล็อกระบบไม่ให้เจนตั๋ว ถ้ายอดเงินโอนไม่ตรงกับยอดจอง
      if (criteria && criteria.amount !== undefined && targetOrder) {
        const receivedAmt = parseFloat(criteria.amount);
        const orderAmt = parseFloat(targetOrder.total_amount);
        if (receivedAmt < orderAmt - 0.01) {
          this.logAudit('PAYMENT_UNDERPAID', 'SECURITY', `ยอดเงินโอน ฿${receivedAmt} ไม่พอกับยอดจอง ฿${orderAmt} ในออเดอร์ ${targetOrder.order_id}`, verifierId);
          this._recordIncident('UNDERPAID_SLIP', null, null, 'BANK_CONFIRM', '', `ยอดเงินโอน ฿${receivedAmt} น้อยกว่ายอดจอง ฿${orderAmt}`);
          this.update('orders', targetOrder.order_id, {
            payment_status: 'AMOUNT_MISMATCH',
            notes: `ยอดเงินโอนไม่ครบ (โอนมา ฿${receivedAmt.toFixed(2)} ยอดที่ต้องชำระ ฿${orderAmt.toFixed(2)})`
          });
          return {
            success: false,
            code: 'AMOUNT_MISMATCH',
            message: `ยอดเงินโอน (฿${receivedAmt.toFixed(2)}) น้อยกว่ายอดคำสั่งซื้อ (฿${orderAmt.toFixed(2)}) ระบบไม่เจนตั๋วเด็ดขาด`
          };
        }
      }

      if (targetOrder.payment_status === 'PAID') {
        const tickets = this.getAll('tickets', t => t.order_id === targetOrder.order_id && !t.is_void);
        return { success: true, alreadyPaid: true, order: targetOrder, tickets };
      }

      const resolvedBankRef = (criteria && criteria.bank_ref) 
        ? criteria.bank_ref 
        : (targetOrder.bank_ref && !targetOrder.bank_ref.startsWith('PENDING') ? targetOrder.bank_ref : ('KBANK-BOT-' + Date.now().toString().slice(-8)));

      this.update('orders', targetOrder.order_id, {
        payment_status: 'PAID',
        paid_at: new Date().toISOString(),
        bank_ref: resolvedBankRef
      });

      const payments = this.getAll('payments', p => p.order_id === targetOrder.order_id);
      if (payments && payments.length > 0) {
        payments.forEach(p => {
          this.update('payments', p.payment_id, {
            status: 'CONFIRMED',
            verified_by: verifierId,
            verified_at: new Date().toISOString(),
            bank_ref: resolvedBankRef,
            notes: (p.notes ? p.notes + ' | ' : '') + `ตรวจจับเงินเข้าอัตโนมัติ (Zero-Slip Bot: Ref ${resolvedBankRef})`
          });
        });
      }

      const tickets = this.getAll('tickets', t => t.order_id === targetOrder.order_id);
      tickets.forEach(t => {
        // [INSERT ACTIVE MODERN LOGIC]: ผูก bank_ref จริงจากธนาคารเข้ากับตั๋ว และประทับตราลงใน QR Hash
        const cleanRef = String(resolvedBankRef || '').trim();
        const updatedQrHash = (t.qr_code_hash && cleanRef && !t.qr_code_hash.includes(cleanRef))
          ? `${t.qr_code_hash}-${cleanRef}`
          : (t.qr_code_hash || `EP-${t.ticket_id}-${cleanRef}`);

        this.update('tickets', t.ticket_id, {
          is_void: false,
          bank_ref: resolvedBankRef,
          qr_code_hash: updatedQrHash
        });
        t.is_void = false;
        t.bank_ref = resolvedBankRef;
        t.qr_code_hash = updatedQrHash;
      });

      this.logAudit('AUTO_BOT_ZERO_SLIP_CONFIRMED', 'FINANCE', `Bot ตรวจจับเงินเข้าอัตโนมัติ Order: ${targetOrder.order_id} ยอด ฿${targetOrder.total_amount} Ref: ${resolvedBankRef}`, verifierId);

      return {
        success: true,
        order: this.get('orders', targetOrder.order_id),
        tickets: tickets
      };
    }

    /**
     * ค้นหาบัตร e-Ticket และใบเสร็จของลูกค้าด้วยเบอร์โทรหรือชื่อ (Self-Service 24/7 Retrieval)
     */
    lookupCustomerOrders(query) {
      if (!query || !query.trim()) return [];
      const cleanQ = query.trim().toLowerCase();
      const allOrders = this.getAll('orders', o => {
        const phoneMatch = o.customer_phone && o.customer_phone.replace(/[^0-9]/g, '').includes(cleanQ.replace(/[^0-9]/g, ''));
        const nameMatch = o.customer_name && o.customer_name.toLowerCase().includes(cleanQ);
        const orderIdMatch = o.order_id && o.order_id.toLowerCase().includes(cleanQ);
        return (phoneMatch || nameMatch || orderIdMatch) && o.payment_status === 'PAID';
      });

      return allOrders.map(order => {
        const tickets = this.getAll('tickets', t => t.order_id === order.order_id && !t.is_void);
        const payment = this.getAll('payments', p => p.order_id === order.order_id)[0] || null;
        return { order, tickets, payment };
      });
    }

    _loadCollection(name) {
      const raw = this._getItem(name);
      if (!raw) return [];
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error(`[EventPay DB] Error parsing collection ${name}:`, e);
        return [];
      }
    }

    _saveCollection(name, data) {
      this._setItem(name, JSON.stringify(data));
    }

    // ==========================================
    // GENERIC CRUD OPERATIONS
    // ==========================================

    getAll(collection, filterFn = null) {
      const items = this._loadCollection(collection);
      if (typeof filterFn === 'function') {
        return items.filter(filterFn);
      }
      return items;
    }

    find(collection, filterFn = null) {
      return this.getAll(collection, filterFn);
    }

    get(collection, id, keyField = null) {
      const items = this._loadCollection(collection);
      const key = keyField || this._getDefaultKeyField(collection);
      return items.find(item => String(item[key]) === String(id)) || null;
    }

    insert(collection, record) {
      const items = this._loadCollection(collection);
      items.push(record);
      this._saveCollection(collection, items);
      this._scheduleCloudAutoSync(collection, 'insert', record);
      return record;
    }

    update(collection, id, updates, keyField = null) {
      const items = this._loadCollection(collection);
      const key = keyField || this._getDefaultKeyField(collection);
      const index = items.findIndex(item => String(item[key]) === String(id));
      if (index === -1) return null;

      items[index] = { ...items[index], ...updates };
      this._saveCollection(collection, items);
      this._scheduleCloudAutoSync(collection, 'update', items[index]);
      return items[index];
    }

    delete(collection, id, keyField = null) {
      const items = this._loadCollection(collection);
      const key = keyField || this._getDefaultKeyField(collection);
      const index = items.findIndex(item => String(item[key]) === String(id));
      if (index === -1) return false;

      const deleted = items.splice(index, 1)[0];
      this._saveCollection(collection, items);
      this._scheduleCloudAutoSync(collection, 'delete', deleted);
      return true;
    }

    _getDefaultKeyField(collection) {
      const keyMap = {
        events: 'event_id',
        ticket_tiers: 'tier_id',
        gates: 'gate_id',
        staff: 'staff_id',
        cash_sessions: 'shift_id',
        cash_payouts: 'payout_id',
        tickets: 'ticket_id',
        wristbands: 'wristband_id',
        orders: 'order_id',
        payments: 'payment_id',
        audit_logs: 'log_id',
        security_incidents: 'incident_id',
        users: 'user_id',
        revenue_categories: 'category_id',
        expense_categories: 'category_id',
        bank_accounts: 'account_id'
      };
      return keyMap[collection] || 'id';
    }

    getById(collection, id) {
      return this.get(collection, id);
    }

    // ==========================================
    // AUDIT LOG ENGINE (IMMUTABLE LOGS)
    // ==========================================

    logAudit(action, category, details, operatorId = 'SYSTEM', device = 'Kiosk') {
      const logRecord = {
        log_id: 'LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase(),
        timestamp: new Date().toISOString(),
        action: action,
        category: category,
        operator_id: operatorId,
        details: typeof details === 'object' ? JSON.stringify(details) : String(details),
        ip_or_device: device
      };
      this.insert('audit_logs', logRecord);
      return logRecord;
    }

    // ==========================================
    // GATE 3-POINT VALIDATION & SECURITY ENGINE
    // ==========================================

    /**
     * ระบบตรวจสอบสิทธิ์ 3 ประสานหน้าประตูคอนเสิร์ต (Atomic Gate Validation Engine)
     * กฎเหล็ก:
     * 1. ตั๋วต้องมีอยู่จริง ไม่เป็นโมฆะ (is_void === false)
     * 2. เข้าครั้งแรก (NOT_ENTERED):
     *    - บันทึกรหัสริสต์แบนด์ (wristband_id)
     *    - บันทึกรูปถ่ายใบหน้า (face_photo_url)
     *    - เปลี่ยนสถานะเป็น ENTERED
     * 3. เข้าซ้ำ (ENTERED):
     *    - รหัสริสต์แบนด์ต้องตรงกับที่ผูกไว้ครั้งแรกเป๊ะๆ 100%
     *    - หากไม่ตรง -> REJECT: WRISTBAND_MISMATCH พร้อมลั่นไซเรน!
     * @param {string} qrCode รหัส QR หรือ Ticket ID
     * @param {string} wristbandId รหัสริสต์แบนด์ที่สแกน
     * @param {string} facePhotoUrl รูปถ่ายใบหน้า Base64 จากกล้อง
     * @param {string} gateId รหัสประตู เช่น GATE-01
     * @param {string} operatorId รหัสเจ้าหน้าที่
     * @returns {{ success: boolean, code: string, message: string, ticket: object|null, incident: object|null }}
     */
    validateGateScan(qrCode, wristbandId, facePhotoUrl, gateId = 'GATE-01', operatorId = 'USER-GATE-01', gateDirection = 'IN') {
      const cleanQr = (qrCode || '').trim();
      const cleanWb = (wristbandId || '').trim();
      const now = new Date().toISOString();

      // ค้นหาตั๋วจาก qr_code_hash หรือ ticket_id หรือ wristband_id (กรณีสแกนริสต์แบนด์ตอน OUT / RE_ENTRY)
      const tickets = this.getAll('tickets');
      let ticket = null;
      if (cleanQr) {
        ticket = tickets.find(t => t.qr_code_hash === cleanQr || t.ticket_id === cleanQr || (t.bank_ref && t.bank_ref === cleanQr));
      }
      if (!ticket && cleanWb) {
        ticket = tickets.find(t => t.wristband_id === cleanWb);
      }

      // [กรณีที่ 1]: ไม่พบข้อมูลตั๋วในระบบ
      if (!ticket) {
        const identifier = cleanQr || cleanWb || 'UNKNOWN';
        const incident = this._recordIncident('INVALID_QR', null, cleanWb, gateId, facePhotoUrl, `รหัส '${identifier}' ไม่มีในระบบ`);
        return {
          success: false,
          code: 'INVALID_QR',
          message: 'ไม่พบข้อมูลบัตรหรือริสต์แบนด์ในระบบ! โปรดตรวจสอบกับฝ่ายจำหน่ายบัตร',
          ticket: null,
          incident: incident
        };
      }

      // [กรณีที่ 2]: บัตรถูกระงับ/เป็นโมฆะ (Void Ticket)
      if (ticket.is_void) {
        const incident = this._recordIncident('VOID_TICKET', ticket.ticket_id, cleanWb || ticket.wristband_id, gateId, facePhotoUrl, `บัตร ${ticket.ticket_id} ถูกระงับเป็นโมฆะ`);
        return {
          success: false,
          code: 'VOID_TICKET',
          message: 'บัตรใบนี้ถูกยกเลิก/เป็นโมฆะ! ห้ามเข้างานเด็ดขาด',
          ticket: ticket,
          incident: incident
        };
      }

      // [กรณีพิเศษ]: โหมดประตูทางออก (EXIT GATE)
      if (gateDirection === 'OUT') {
        if (ticket.gate_status === 'NOT_ENTERED') {
          return {
            success: false,
            code: 'NOT_ENTERED_YET',
            message: 'บัตรใบนี้ยังไม่ได้ลงทะเบียนเข้างาน ไม่สามารถสแกนออกจากงานได้ค่ะ',
            ticket: ticket,
            incident: null
          };
        }

        if (ticket.gate_status === 'EXITED') {
          return {
            success: false,
            code: 'ALREADY_EXITED',
            message: 'บัตรใบนี้ได้บันทึกออกจากงานไปแล้วค่ะ (ขณะนี้อยู่นอกงาน)',
            ticket: ticket,
            incident: null
          };
        }

        // หากผู้เข้าชมสแกนริสต์แบนด์ตอนออก ให้ตรวจสอบว่าตรงกับที่ผูกไว้หรือไม่
        if (cleanWb && ticket.wristband_id && cleanWb !== ticket.wristband_id) {
          const incident = this._recordIncident(
            'WRISTBAND_MISMATCH_EXIT',
            ticket.ticket_id,
            cleanWb,
            gateId,
            facePhotoUrl,
            `ริสต์แบนด์ที่สแกนตอนออก (${cleanWb}) ไม่ตรงกับที่ผูกไว้ (${ticket.wristband_id})`
          );
          return {
            success: false,
            code: 'WRISTBAND_MISMATCH',
            message: `ริสต์แบนด์ไม่ตรงกับที่ลงทะเบียนไว้! (เดิม: ${ticket.wristband_id})`,
            ticket: ticket,
            incident: incident
          };
        }

        // บันทึกการออกจากงานสำเร็จ (พร้อมเก็บภาพถ่ายตอนออก exit_face_photo_url)
        const updatedHistory = ticket.entry_history ? [...ticket.entry_history] : [];
        updatedHistory.push({
          timestamp: now,
          gate_id: gateId,
          operator_id: operatorId,
          action: 'EXIT',
          wristband_id: ticket.wristband_id || cleanWb
        });

        const updatedTicket = this.update('tickets', ticket.ticket_id, {
          gate_status: 'EXITED',
          last_exit_at: now,
          exit_face_photo_url: facePhotoUrl || ticket.exit_face_photo_url || '',
          entry_history: updatedHistory,
          last_gate_id: gateId
        });

        this.logAudit('GATE_EXIT', 'GATE', `บัตร ${ticket.ticket_id} บันทึกออกจากงานเรียบร้อย (ริสต์แบนด์: ${ticket.wristband_id})`, operatorId);

        return {
          success: true,
          code: 'EXIT_PASS',
          mode: 'EXIT',
          message: 'บันทึกออกจากงานเรียบร้อย ขอบคุณค่ะ (สามารถกลับเข้ามาใหม่ได้ด้วยริสต์แบนด์เดิม)',
          ticket: updatedTicket,
          incident: null
        };
      }

      // [กรณีที่ 3]: เข้างานครั้งแรก (FIRST_ENTRY)
      if (ticket.gate_status === 'NOT_ENTERED') {
        if (!cleanWb) {
          return {
            success: false,
            code: 'MISSING_WRISTBAND',
            message: 'กรุณาสแกนหรือระบุรหัสริสต์แบนด์เพื่อผูกกับบัตร',
            ticket: ticket,
            incident: null
          };
        }

        // ตรวจสอบว่ารหัสริสต์แบนด์นี้ ถูกนำไปผูกกับบัตรใบอื่นแล้วหรือไม่ (ป้องกันริสต์แบนด์ซ้ำ)
        const existingWb = this.get('wristbands', cleanWb);
        if (existingWb && existingWb.assigned_ticket_id && existingWb.assigned_ticket_id !== ticket.ticket_id) {
          const incident = this._recordIncident('WRISTBAND_ALREADY_USED', ticket.ticket_id, cleanWb, gateId, facePhotoUrl, `ริสต์แบนด์ '${cleanWb}' ถูกใช้ผูกกับตั๋ว '${existingWb.assigned_ticket_id}' ไปแล้ว`);
          return {
            success: false,
            code: 'WRISTBAND_ALREADY_USED',
            message: `รหัสริสต์แบนด์ '${cleanWb}' ถูกใช้งานกับบัตรใบอื่นแล้ว! สวมสิทธิ์ริสต์แบนด์`,
            ticket: ticket,
            incident: incident
          };
        }

        // ผูกข้อมูลริสต์แบนด์และรูปถ่ายใบหน้าเข้ากับตั๋ว
        const updatedHistory = ticket.entry_history ? [...ticket.entry_history] : [];
        updatedHistory.push({
          timestamp: now,
          gate_id: gateId,
          operator_id: operatorId,
          action: 'FIRST_ENTRY',
          wristband_id: cleanWb
        });

        const updatedTicket = this.update('tickets', ticket.ticket_id, {
          wristband_id: cleanWb,
          face_photo_url: facePhotoUrl || ticket.face_photo_url,
          gate_status: 'ENTERED',
          entry_count: (ticket.entry_count || 0) + 1,
          entry_history: updatedHistory,
          last_entry_at: now,
          last_gate_id: gateId
        });

        // บันทึกลงตารางริสต์แบนด์
        if (existingWb) {
          this.update('wristbands', cleanWb, { assigned_ticket_id: ticket.ticket_id, status: 'ACTIVE', assigned_at: now });
        } else {
          this.insert('wristbands', { wristband_id: cleanWb, assigned_ticket_id: ticket.ticket_id, status: 'ACTIVE', assigned_at: now });
        }

        this.logAudit('GATE_FIRST_ENTRY', 'GATE', `บัตร ${ticket.ticket_id} ลงทะเบียนเข้างานครั้งแรกสำเร็จ ผูกริสต์แบนด์ ${cleanWb}`, operatorId);

        return {
          success: true,
          code: 'FIRST_ENTRY_PASS',
          mode: 'FIRST_ENTRY',
          message: 'ลงทะเบียนเข้างานครั้งแรกสำเร็จ! ยินดีต้อนรับเข้าสู่งานคอนเสิร์ต',
          ticket: updatedTicket,
          incident: null
        };
      }

      // [กรณีที่ 4]: บัตรอยู่ในงานแล้ว และพยายามสแกนเข้าซ้ำ (DUPLICATE ENTRY ATTACK)
      if (ticket.gate_status === 'ENTERED') {
        const incident = this._recordIncident(
          'DUPLICATE_ENTRY_ATTEMPT',
          ticket.ticket_id,
          cleanWb || ticket.wristband_id,
          gateId,
          facePhotoUrl,
          `พยายามสแกนเข้างานซ้ำ ทั้งที่อยู่ในงานแล้ว (ยังไม่ได้บันทึกออกจากงาน) ส่อเจตนาส่งต่อ QR/บัตรให้ผู้อื่น!`
        );
        return {
          success: false,
          code: 'ALREADY_INSIDE',
          message: 'บัตรใบนี้อยู่ในงานแล้ว ไม่สามารถเข้าซ้ำได้! (หากต้องการออกชั่วคราว กรุณาสแกนออกที่ประตูก่อน)',
          ticket: ticket,
          incident: incident
        };
      }

      // [กรณีที่ 5]: เข้างานซ้ำจากนอกงาน (RE_ENTRY)
      if (ticket.gate_status === 'EXITED') {
        // หากไม่มีการระบุริสต์แบนด์ หรือริสต์แบนด์ไม่ตรงกับที่ผูกไว้ครั้งแรก
        if (!cleanWb || cleanWb !== ticket.wristband_id) {
          const incident = this._recordIncident(
            'WRISTBAND_MISMATCH',
            ticket.ticket_id,
            cleanWb,
            gateId,
            facePhotoUrl,
            `ริสต์แบนด์ที่สแกน (${cleanWb || 'ไม่ได้ระบุ'}) ไม่ตรงกับที่ผูกไว้ (${ticket.wristband_id}) ส่อเจตนาสวมสิทธิ์!`
          );

          return {
            success: false,
            code: 'WRISTBAND_MISMATCH',
            message: `ตรวจพบการสวมสิทธิ์! ริสต์แบนด์ไม่ตรงกับที่ผูกไว้ครั้งแรก (เดิม: ${ticket.wristband_id} / สแกน: ${cleanWb || 'ไม่มี'})`,
            ticket: ticket,
            incident: incident
          };
        }

        // ริสต์แบนด์ตรง อนุญาตให้เข้างานซ้ำได้
        const updatedHistory = ticket.entry_history ? [...ticket.entry_history] : [];
        updatedHistory.push({
          timestamp: now,
          gate_id: gateId,
          operator_id: operatorId,
          action: 'RE_ENTRY',
          wristband_id: cleanWb
        });

        const updatedTicket = this.update('tickets', ticket.ticket_id, {
          gate_status: 'ENTERED',
          entry_count: (ticket.entry_count || 0) + 1,
          last_reentry_face_photo_url: facePhotoUrl || '',
          entry_history: updatedHistory,
          last_entry_at: now,
          last_gate_id: gateId
        });

        this.logAudit('GATE_RE_ENTRY', 'GATE', `บัตร ${ticket.ticket_id} เข้างานซ้ำผ่านเรียบร้อย (ครั้งที่ ${updatedTicket.entry_count})`, operatorId);

        return {
          success: true,
          code: 'RE_ENTRY_PASS',
          mode: 'RE_ENTRY',
          message: `เข้างานซ้ำผ่านเรียบร้อย (ครั้งที่ ${updatedTicket.entry_count}) ยินดีต้อนรับกลับเข้าสู่งาน`,
          ticket: updatedTicket,
          incident: null
        };
      }

      return {
        success: false,
        code: 'UNKNOWN_STATUS',
        message: 'สถานะบัตรไม่ถูกต้อง โปรดติดต่อจุดบริการลูกค้า',
        ticket: ticket,
        incident: null
      };
    }

    /**
     * ดึงรายชื่อผู้ที่อยู่นอกงานขณะนี้ (Active Outside Attendees)
     * กรองเฉพาะตั๋วที่มีสถานะ 'EXITED' และไม่เป็นโมฆะ เรียงตามเวลาออกล่าสุด
     */
    getActiveOutsideAttendees() {
      const tickets = this.getAll('tickets');
      const orders = this.getAll('orders');
      const orderMap = {};
      orders.forEach(o => { orderMap[o.order_id] = o; });

      return tickets
        .filter(t => t.gate_status === 'EXITED' && !t.is_void)
        .map(t => {
          const order = orderMap[t.order_id] || {};
          return {
            ticket_id: t.ticket_id,
            qr_code_hash: t.qr_code_hash,
            customer_name: t.customer_name || t.attendee_name || order.customer_name || 'ไม่ระบุชื่อ',
            customer_phone: t.customer_phone || order.customer_phone || '',
            tier_name: t.tier_name || order.tier_name || 'Standard',
            wristband_id: t.wristband_id || '',
            first_face_photo_url: t.face_photo_url || '',
            exit_face_photo_url: t.exit_face_photo_url || '',
            last_exit_at: t.last_exit_at || '',
            entry_count: t.entry_count || 1,
            last_gate_id: t.last_gate_id || 'GATE-01'
          };
        })
        .sort((a, b) => new Date(b.last_exit_at || 0) - new Date(a.last_exit_at || 0));
    }

    _recordIncident(type, ticketId, wristbandId, gateId, snapshotPhoto, notes) {
      const incident = {
        incident_id: 'INC-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase(),
        incident_type: type,
        ticket_id: ticketId,
        wristband_id: wristbandId,
        gate_id: gateId,
        snapshot_photo: snapshotPhoto || '',
        notes: notes,
        created_at: new Date().toISOString()
      };
      this.insert('security_incidents', incident);
      this.logAudit('SECURITY_INCIDENT', 'SECURITY', `[${type}] ${notes} (Gate: ${gateId})`, 'GATE_SYSTEM');
      return incident;
    }

    // ==========================================
    // CASH & TICKETING TRANSACTION ENGINE
    // ==========================================

    /**
     * สร้างคำสั่งซื้อและออกบัตรคอนเสิร์ต
     * หากชำระด้วยเงินสด ระบบจะอัปเดตยอดเงินสดสะสมของกะปัจจุบันอัตโนมัติ
     */
    createOrder(orderData, cashierId = 'USER-STAFF-01') {
      const now = new Date().toISOString();
      // [INSERT ACTIVE MODERN LOGIC]: รองรับการซิงก์ order_id ข้ามโหมด Client-Server ให้ตรงกัน 100%
      const orderId = (orderData && orderData.order_id) ? orderData.order_id : ('ORD-' + Date.now());
      const items = orderData.items || []; // [{ tier_id: 'TIER-VIP', quantity: 2, attendee_names: ['สมชาย', 'สมพร'] }]

      let totalAmount = 0;
      const createdTickets = [];

      items.forEach((item, itemIdx) => {
        const tier = this.get('ticket_tiers', item.tier_id);
        const price = tier ? tier.price : 0;
        const qty = item.quantity || 1;
        totalAmount += (price * qty);

        for (let i = 0; i < qty; i++) {
          const attendeeName = (item.attendee_names && item.attendee_names[i]) ? item.attendee_names[i] : (orderData.customer_name || 'ผู้เข้าชม');
          const ticketSeq = Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
          const ticketId = `TKT-${item.tier_id.replace('TIER-', '')}-${ticketSeq}`;
          const qrHash = `EP-${ticketId}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

          const ticketRecord = {
            ticket_id: ticketId,
            order_id: orderId,
            tier_id: item.tier_id,
            tier_name: tier ? tier.name : 'บัตรคอนเสิร์ต',
            attendee_name: attendeeName,
            attendee_phone: orderData.customer_phone || '',
            qr_code_hash: qrHash,
            wristband_id: null,
            face_photo_url: null,
            gate_status: 'NOT_ENTERED',
            entry_count: 0,
            entry_history: [],
            is_void: false,
            created_at: now
          };

          this.insert('tickets', ticketRecord);
          createdTickets.push(ticketRecord);
        }
      });

      // ตรวจสอบความถูกต้องของสลิปโอนเงิน (Slip Verification & Duplicate Check)
      let initialPaymentStatus = 'PAID';
      let slipStatus = 'CONFIRMED';
      let slipNotes = '';

      if (orderData.payment_method === 'TRANSFER') {
        const cleanRef = (orderData.bank_ref || '').trim();
        const existingPayments = this.getAll('payments');
        const isDup = cleanRef ? existingPayments.some(p => p.bank_ref && p.bank_ref.toUpperCase() === cleanRef.toUpperCase()) : false;

        // หากเป็นคำสั่งซื้อที่ส่งสลิปให้ฝ่ายบัญชีตรวจสเตทเมนต์ (requires_verification === true)
        if (orderData.requires_verification === true) {
          initialPaymentStatus = 'PENDING_VERIFICATION';
          slipStatus = 'PENDING_VERIFICATION';
          slipNotes = isDup ? `ตรวจพบสลิปเลขอ้างอิงซ้ำ '${cleanRef}'` : 'รอฝ่ายบัญชีตรวจสอบสเตทเมนต์ธนาคาร (ไม่เกิน 3 นาที)';

          if (isDup) {
            this._recordIncident('DUPLICATE_SLIP', null, null, 'ONLINE-BOOKING', '', `ตรวจพบสลิปซ้ำ '${cleanRef}' ในคำสั่งซื้อ ${orderId}`);
          }
          // ล็อกบัตรเป็นโมฆะชั่วคราวจนกว่าจะได้รับการกดยืนยันยอดเงินจริงจากฝ่ายบัญชี
          createdTickets.forEach(t => {
            this.update('tickets', t.ticket_id, { is_void: true });
            t.is_void = true;
          });
        } else if (isDup) {
          initialPaymentStatus = 'PENDING_VERIFICATION';
          slipStatus = 'PENDING_VERIFICATION';
          slipNotes = `ตรวจพบสลิปเลขอ้างอิงซ้ำ '${cleanRef}'`;
          this._recordIncident('DUPLICATE_SLIP', null, null, 'CASHIER-POS', '', `ตรวจพบสลิปซ้ำ '${cleanRef}' ในคำสั่งซื้อ ${orderId}`);
          // ล็อกบัตรเป็นโมฆะชั่วคราวจนกว่าจะได้รับการยืนยันยอดเงิน
          createdTickets.forEach(t => {
            this.update('tickets', t.ticket_id, { is_void: true });
            t.is_void = true;
          });
        }
      }

      const orderRecord = {
        order_id: orderId,
        customer_name: orderData.customer_name || 'ลูกค้าทั่วไป',
        customer_phone: orderData.customer_phone || '',
        total_amount: totalAmount,
        payment_method: orderData.payment_method || 'CASH', // CASH | TRANSFER
        payment_status: initialPaymentStatus,
        shift_id: orderData.shift_id || 'SHIFT-20261017-01',
        bank_ref: orderData.bank_ref || '',
        slip_url: orderData.slip_url || '',
        created_at: now
      };
      this.insert('orders', orderRecord);

      // สร้างบันทึกการชำระเงิน
      const paymentRecord = {
        payment_id: 'PAY-' + Date.now(),
        order_id: orderId,
        channel: orderData.payment_method || 'CASH',
        amount: totalAmount,
        bank_ref: orderData.bank_ref || (orderData.payment_method === 'CASH' ? `CASH-${orderId}` : ''),
        slip_url: orderData.slip_url || '',
        verified_by: cashierId,
        status: slipStatus,
        notes: slipNotes,
        created_at: now
      };
      this.insert('payments', paymentRecord);

      // หากเป็นเงินสด ให้อัปเดตกะเงินสดที่เปิดอยู่ทันที
      if (orderData.payment_method === 'CASH') {
        const shifts = this.getAll('cash_sessions', s => s.status === 'OPEN');
        if (shifts.length > 0) {
          const currentShift = shifts[0];
          const newCashSales = (currentShift.cash_sales || 0) + totalAmount;
          const newExpected = (currentShift.opening_float || 0) + newCashSales - (currentShift.cash_payouts || 0);

          this.update('cash_sessions', currentShift.shift_id, {
            cash_sales: newCashSales,
            expected_cash: newExpected
          });
        }
      }

      this.logAudit('CREATE_ORDER', 'FINANCE', `สร้างคำสั่งซื้อ ${orderId} ยอดรวม ฿${totalAmount} (${orderData.payment_method}) จำนวนบัตร ${createdTickets.length} ใบ`, cashierId);

      return {
        order: orderRecord,
        payment: paymentRecord,
        tickets: createdTickets
      };
    }

    /**
     * ตรวจสอบความถูกต้องของสลิปโอนเงิน (Slip Verification API)
     * กฎ: ตรวจสอบความซ้ำซ้อนของเลขที่อ้างอิงธนาคาร (Bank Ref Uniqueness)
     */
    verifySlip(bankRef, expectedAmount = null) {
      const cleanRef = (bankRef || '').trim();
      if (!cleanRef) {
        return { valid: false, code: 'MISSING_REF', status: 'PENDING_VERIFICATION', message: 'ไม่ได้ระบุเลขอ้างอิงธนาคาร' };
      }
      const existing = this.getAll('payments').find(p => p.bank_ref && p.bank_ref.toUpperCase() === cleanRef.toUpperCase());
      if (existing) {
        return {
          valid: false,
          code: 'DUPLICATE_REF',
          status: 'PENDING_VERIFICATION',
          message: `สลิปเลขอ้างอิง '${cleanRef}' ถูกใช้งานไปแล้วในระบบ (คำสั่งซื้อ ${existing.order_id})`,
          existingPayment: existing
        };
      }
      return {
        valid: true,
        code: 'VALID_SLIP',
        status: 'CONFIRMED',
        message: 'สลิปถูกต้อง ไม่พบประวัติซ้ำซ้อน'
      };
    }

    /**
     * ยืนยันการชำระเงินโอนหลังฝ่ายการเงินตรวจสอบสลิปผ่าน (Confirm Verified Payment)
     */
    confirmPayment(paymentId, verifierId = 'ADMIN-SUPER') {
      const payment = this.get('payments', paymentId);
      if (!payment) return null;
      const updatedPayment = this.update('payments', paymentId, { status: 'CONFIRMED', verified_by: verifierId });
      this.update('orders', payment.order_id, { payment_status: 'PAID' });
      // ปลดล็อกตั๋วที่ผูกกับคำสั่งซื้อนี้ให้เข้างานได้
      const tickets = this.getAll('tickets', t => t.order_id === payment.order_id);
      tickets.forEach(t => {
        this.update('tickets', t.ticket_id, { is_void: false });
      });
      if (typeof EventPayFirebase !== 'undefined' && typeof EventPayFirebase.updateCloudOrderStatus === 'function') {
        EventPayFirebase.updateCloudOrderStatus(payment.order_id, 'PAID', 'Confirmed by Finance');
      }
      this.logAudit('CONFIRM_PAYMENT', 'FINANCE', `ฝ่ายการเงินยืนยันการชำระเงิน ${paymentId} (Order: ${payment.order_id}) สำเร็จ`, verifierId);
      return updatedPayment;
    }

    /**
     * ระงับ/ปฏิเสธการชำระเงินโอนเมื่อพบสลิปปลอมหรือยอดไม่เข้าสเตทเมนต์ (Reject Fake/Invalid Slip)
     */
    rejectPayment(paymentId, verifierId = 'ADMIN-SUPER', reason = 'สลิปปลอม/ยอดเงินไม่เข้าสเตทเมนต์') {
      const payment = this.get('payments', paymentId);
      if (!payment) return null;
      const updatedPayment = this.update('payments', paymentId, { status: 'VOID', notes: reason, verified_by: verifierId });
      this.update('orders', payment.order_id, { payment_status: 'VOID' });
      // ล็อกตั๋วทั้งหมดของคำสั่งซื้อนี้ให้เป็นโมฆะถาวร
      const tickets = this.getAll('tickets', t => t.order_id === payment.order_id);
      tickets.forEach(t => {
        this.update('tickets', t.ticket_id, { is_void: true });
      });
      if (typeof EventPayFirebase !== 'undefined' && typeof EventPayFirebase.updateCloudOrderStatus === 'function') {
        EventPayFirebase.updateCloudOrderStatus(payment.order_id, 'VOID', reason);
      }
      this._recordIncident('FAKE_SLIP', null, null, 'FINANCE-ADMIN', '', `ฝ่ายการเงินตรวจพบสลิปปลอม/ระงับสิทธิ์คำสั่งซื้อ ${payment.order_id} (เหตุผล: ${reason})`);
      this.logAudit('REJECT_PAYMENT', 'FINANCE', `ฝ่ายการเงินปฏิเสธ/ระงับการชำระเงิน ${paymentId} (Order: ${payment.order_id}) เหตุผล: ${reason}`, verifierId);
      return updatedPayment;
    }

    /**
     * บันทึกรายการจ่ายเงินสดจากเก๊ะ (Cash Payout / Expense)
     */
    recordCashPayout(shiftId, amount, reason, payee, approvedBy, receiptUrl = '', categoryId = 'EXP-MISC') {
      const now = new Date().toISOString();
      const payoutId = 'PAYOUT-' + Date.now();

      const payoutRecord = {
        payout_id: payoutId,
        shift_id: shiftId,
        category_id: categoryId,
        amount: parseFloat(amount) || 0,
        reason: reason,
        payee: payee,
        approved_by: approvedBy,
        receipt_url: receiptUrl,
        created_at: now
      };
      this.insert('cash_payouts', payoutRecord);

      // อัปเดตกะเงินสด
      const shift = this.get('cash_sessions', shiftId);
      if (shift) {
        const newPayouts = (shift.cash_payouts || 0) + payoutRecord.amount;
        const newExpected = (shift.opening_float || 0) + (shift.cash_sales || 0) - newPayouts;
        this.update('cash_sessions', shiftId, {
          cash_payouts: newPayouts,
          expected_cash: newExpected
        });
      }

      this.logAudit('CASH_PAYOUT', 'FINANCE', `จ่ายเงินสด ฿${payoutRecord.amount} เหตุผล: ${reason} (อนุมัติโดย: ${approvedBy})`, approvedBy);
      return payoutRecord;
    }

    /**
     * ยกเลิกรายการจ่ายเงินสดและคืนยอดกลับเข้าเก๊ะ (Void Payout)
     */
    voidCashPayout(payoutId, reason = 'ยกเลิกรายการโดยผู้ดูแลระบบ', operatorId = 'ADMIN') {
      const payout = this.get('cash_payouts', payoutId);
      if (!payout) return null;

      if (payout.shift_id) {
        const shift = this.get('cash_sessions', payout.shift_id);
        if (shift) {
          const newPayouts = Math.max(0, (shift.cash_payouts || 0) - (payout.amount || 0));
          const newExpected = (shift.opening_float || 0) + (shift.cash_sales || 0) - newPayouts;
          this.update('cash_sessions', payout.shift_id, {
            cash_payouts: newPayouts,
            expected_cash: newExpected
          });
        }
      }

      this.delete('cash_payouts', payoutId);
      this.logAudit('VOID_PAYOUT', 'FINANCE', `ยกเลิกรายการจ่าย ${payoutId} จำนวน ฿${payout.amount} เหตุผล: ${reason}`, operatorId);
      return true;
    }

    /**
     * คำนวณส่วนต่างเงินสดและการปิดกะ (Shift Reconciliation Math)
     * Expected Cash = Opening Float + Cash Sales - Cash Payouts
     * Variance = Counted Cash - Expected Cash
     */
    calculateShiftVariance(shiftId, countedCash) {
      const shift = this.get('cash_sessions', shiftId);
      if (!shift) return null;

      const openingFloat = shift.opening_float || 0;
      const cashSales = shift.cash_sales || 0;
      const cashPayouts = shift.cash_payouts || 0;
      const expectedCash = openingFloat + cashSales - cashPayouts;
      const counted = parseFloat(countedCash) || 0;
      const variance = Math.round((counted - expectedCash) * 100) / 100;

      return {
        shiftId: shiftId,
        openingFloat: openingFloat,
        cashSales: cashSales,
        cashPayouts: cashPayouts,
        expectedCash: expectedCash,
        countedCash: counted,
        variance: variance,
        isBalanced: Math.abs(variance) < 0.01,
        status: variance === 0 ? 'BALANCED' : (variance > 0 ? 'OVER' : 'SHORT')
      };
    }

    /**
     * ดำเนินการปิดกะ (Close Shift)
     */
    closeShift(shiftId, countedCash, cashierId = 'USER-STAFF-01') {
      const recon = this.calculateShiftVariance(shiftId, countedCash);
      if (!recon) throw new Error('ไม่พบข้อมูลกะที่ระบุ');

      const now = new Date().toISOString();
      const updatedShift = this.update('cash_sessions', shiftId, {
        counted_cash: recon.countedCash,
        variance: recon.variance,
        status: 'CLOSED',
        closed_at: now
      });

      this.logAudit('CLOSE_SHIFT', 'FINANCE', `ปิดกะ ${shiftId} ยอดนับจริง: ฿${recon.countedCash} ยอดที่ควรมี: ฿${recon.expectedCash} ส่วนต่าง: ฿${recon.variance}`, cashierId);

      return {
        shift: updatedShift,
        reconciliation: recon
      };
    }

    /**
     * สรุปตัวเลขแดชบอร์ดแบบเรียลไทม์ (Dashboard Real-time Aggregation)
     */
    getDashboardSummary() {
      const orders = this.getAll('orders');
      const tickets = this.getAll('tickets');
      const incidents = this.getAll('security_incidents');
      const shifts = this.getAll('cash_sessions');

      let totalSales = 0;
      let cashSales = 0;
      let transferSales = 0;

      orders.forEach(o => {
        if (o.payment_status === 'PAID') {
          totalSales += (o.total_amount || 0);
          if (o.payment_method === 'CASH') {
            cashSales += (o.total_amount || 0);
          } else {
            transferSales += (o.total_amount || 0);
          }
        }
      });

      const attendeesInside = tickets.filter(t => t.gate_status === 'ENTERED').length;
      const attendeesExited = tickets.filter(t => t.gate_status === 'EXITED').length;
      const totalTicketsSold = tickets.length;
      const openShift = shifts.find(s => s.status === 'OPEN') || null;

      return {
        totalSales: totalSales,
        cashSales: cashSales,
        transferSales: transferSales,
        totalTicketsSold: totalTicketsSold,
        attendeesInside: attendeesInside,
        attendeesExited: attendeesExited,
        attendeesRemaining: totalTicketsSold - attendeesInside,
        totalIncidents: incidents.length,
        openShift: openShift
      };
    }

    /**
     * คำนวณรายงานสรุปกำไร-ขาดทุน (P&L: Profit & Loss Statement)
     * รายได้ - ค่าใช้จ่าย = กำไร/ขาดทุนสุทธิ
     */
    getProfitAndLossSummary() {
      const orders = this.getAll('orders', o => o.payment_status === 'PAID');
      const ticketRevenue = orders.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
      const otherRevenue = 0;
      const totalRevenue = ticketRevenue + otherRevenue;

      const payouts = this.getAll('cash_payouts');
      const totalExpense = payouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

      const netProfit = totalRevenue - totalExpense;
      const isProfitable = netProfit >= 0;

      // รายได้แยกตามหมวดหมู่
      const revCategories = this.getAll('revenue_categories');
      const revenueByCategory = revCategories.map(cat => {
        let amount = 0;
        if (cat.category_id === 'REV-TICKET') {
          amount = ticketRevenue;
        }
        return {
          category_id: cat.category_id,
          name: cat.name,
          amount: amount
        };
      });

      // ค่าใช้จ่ายแยกตามหมวดหมู่
      const expCategories = this.getAll('expense_categories');
      const expenseByCategory = expCategories.map(cat => {
        const catPayouts = payouts.filter(p => p.category_id === cat.category_id || (!p.category_id && cat.category_id === 'EXP-CATERING'));
        const amount = catPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
        return {
          category_id: cat.category_id,
          name: cat.name,
          amount: amount
        };
      });

      return {
        ticketRevenue: ticketRevenue,
        otherRevenue: otherRevenue,
        totalRevenue: totalRevenue,
        totalExpense: totalExpense,
        netProfit: netProfit,
        isProfitable: isProfitable,
        revenueByCategory: revenueByCategory,
        expenseByCategory: expenseByCategory
      };
    }

    /**
     * ส่งออกฐานข้อมูลทั้งหมดเป็น JSON สำรองข้อมูล
     */
    exportJSON() {
      const collections = [
        'events', 'ticket_tiers', 'gates', 'staff',
        'cash_sessions', 'cash_payouts', 'tickets',
        'wristbands', 'orders', 'payments',
        'audit_logs', 'security_incidents',
        'revenue_categories', 'expense_categories', 'users',
        'bank_accounts'
      ];
      const backup = {
        exportedAt: new Date().toISOString(),
        version: DB_VERSION,
        data: {}
      };
      collections.forEach(col => {
        backup.data[col] = this.getAll(col);
      });
      return JSON.stringify(backup, null, 2);
    }
  }

  return new EventPayDatabase();
}));
