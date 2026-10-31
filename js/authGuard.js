/**
 * ============================================================================
 * EVENTPAY AUTHENTICATION & ROLE-BASED ACCESS CONTROL (js/authGuard.js)
 * โครงการ: EventPay (โครงการระบบโอนและเงินสด รับเงิน-จ่ายเงิน งานคอนเสิร์ต)
 * พิกัด: D:\BillingApp\Antigravity\EventPay\js\authGuard.js
 * สถาปัตยกรรม: Unified RBAC, Session Guard & 4-Portal Interlink Security
 * ============================================================================
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EventPayAuth = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY_AUTH_USER = 'eventpay_auth_current_user';
  const COLLECTION_USERS = 'users';

  // ข้อมูลผู้ใช้งานเริ่มต้นทางการ 5 บัญชีหลัก (The 5 Official Accounts by Thep-Apai)
  const DEFAULT_SEED_USERS = [
    {
      user_id: 'USER-ADMIN-01',
      username: 'admin',
      password: '9999',
      name: 'Admin',
      role: 'ADMIN',
      permissions: {
        booking: true,
        index: true,
        kiosk: true,
        admin: true
      },
      created_at: new Date().toISOString()
    },
    {
      user_id: 'USER-ACC-01',
      username: 'account',
      password: '8888',
      name: 'Account',
      role: 'ACCOUNTANT',
      permissions: {
        booking: true,
        index: true,
        kiosk: true,
        admin: false
      },
      created_at: new Date().toISOString()
    },
    {
      user_id: 'USER-FIN-01',
      username: 'finance',
      password: '7777',
      name: 'finance',
      role: 'ACCOUNTANT',
      permissions: {
        booking: true,
        index: true,
        kiosk: true,
        admin: false
      },
      created_at: new Date().toISOString()
    },
    {
      user_id: 'USER-CASHIER-01',
      username: 'cashier',
      password: '1111',
      name: 'cashier',
      role: 'STAFF',
      permissions: {
        booking: true,
        index: true,
        kiosk: true,
        admin: false
      },
      created_at: new Date().toISOString()
    },
    {
      user_id: 'USER-GUARD-01',
      username: 'security guard',
      password: '2222',
      name: 'Security guard',
      role: 'STAFF',
      permissions: {
        booking: false,
        index: false,
        kiosk: true,
        admin: false
      },
      created_at: new Date().toISOString()
    }
  ];

  class AuthGuardEngine {
    constructor() {
      this.currentUser = null;
      this.init();
    }

    init() {
      this._seedUsersIfEmpty();
      this.currentUser = this.loadSession();
      this._injectStyles();
    }

    _getDB() {
      if (typeof window !== 'undefined' && window.EventPayDB) {
        return window.EventPayDB;
      }
      return null;
    }

    _seedUsersIfEmpty() {
      const db = this._getDB();
      const normalize = str => String(str || '').trim().toLowerCase().replace(/\s+/g, ' ');

      if (db) {
        let users = db.getAll(COLLECTION_USERS);
        if (!users || users.length === 0) {
          // ฐานข้อมูลว่างเปล่า: บันทึก 5 บัญชีทางการของเทพอภัย
          DEFAULT_SEED_USERS.forEach(u => db.insert(COLLECTION_USERS, u));
        } else {
          /* [REMARKED BY THEP-APAI PROTOCOL: ตรรกะเดิมที่ข้ามการอัปเดตรหัสผ่านเมื่อพบบัญชีเดิม เอาไว้ตรวจสอบเปรียบเทียบ]
          DEFAULT_SEED_USERS.forEach(seedUser => {
            const cleanSeedName = seedUser.username.trim().toLowerCase();
            const exists = users.some(u => String(u.username || '').trim().toLowerCase() === cleanSeedName);
            if (!exists) {
              db.insert(COLLECTION_USERS, seedUser);
            }
          });
          */

          // [INSERTED ACTIVE LOGIC: THEP-APAI SEAMLESS MIGRATION & HEALING]
          // แทรกตรรกะใหม่ตามคำสอนของเทพอภัย: อัปเกรด 5 บัญชีทางการให้ตรงกับ Master เสมอ
          // ป้องกันข้อมูลเก่าตกค้างในเครื่องบล็อกการทำงาน โดยไม่ลบหรือทำลายบัญชีที่ผู้ใช้สร้างเพิ่มเอง
          DEFAULT_SEED_USERS.forEach(seedUser => {
            const cleanSeedName = normalize(seedUser.username);
            const existingIndex = users.findIndex(u => normalize(u.username) === cleanSeedName);
            if (existingIndex === -1) {
              // ยังไม่มีบัญชีนี้: แทรกเพิ่มใหม่ทันที
              db.insert(COLLECTION_USERS, seedUser);
            } else {
              // พบบัญชีทางการเดิม: อัปเกรดรหัสผ่านและสิทธิ์ให้ตรงกับ Master ทันที
              const existing = users[existingIndex];
              if (String(existing.password).trim() !== String(seedUser.password).trim() || existing.role !== seedUser.role) {
                db.update(COLLECTION_USERS, existing.user_id, {
                  password: seedUser.password,
                  role: seedUser.role,
                  permissions: seedUser.permissions,
                  name: seedUser.name || existing.name
                });
              }
            }
          });
        }
      } else if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem('eventpay_db_' + COLLECTION_USERS);
        if (!raw) {
          localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(DEFAULT_SEED_USERS));
        } else {
          try {
            let localUsers = JSON.parse(raw);
            if (!Array.isArray(localUsers) || localUsers.length === 0) {
              localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(DEFAULT_SEED_USERS));
            } else {
              /* [REMARKED BY THEP-APAI PROTOCOL: ตรรกะเดิมใน localStorage ที่ข้ามการอัปเดตเมื่อเจอบัญชีเดิม]
              let updated = false;
              DEFAULT_SEED_USERS.forEach(seedUser => {
                const cleanSeedName = seedUser.username.trim().toLowerCase();
                const exists = localUsers.some(u => String(u.username || '').trim().toLowerCase() === cleanSeedName);
                if (!exists) {
                  localUsers.push(seedUser);
                  updated = true;
                }
              });
              if (updated) {
                localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(localUsers));
              }
              */

              // [INSERTED ACTIVE LOGIC: THEP-APAI SEAMLESS LOCALSTORAGE HEALING]
              // แทรกตรรกะใหม่: ตรวจสอบและอัปเกรดรหัสผ่าน 5 บัญชีทางการใน LocalStorage อัตโนมัติ
              let updated = false;
              DEFAULT_SEED_USERS.forEach(seedUser => {
                const cleanSeedName = normalize(seedUser.username);
                const existingIndex = localUsers.findIndex(u => normalize(u.username) === cleanSeedName);
                if (existingIndex === -1) {
                  localUsers.push(seedUser);
                  updated = true;
                } else {
                  const existing = localUsers[existingIndex];
                  if (String(existing.password).trim() !== String(seedUser.password).trim() || existing.role !== seedUser.role) {
                    existing.password = seedUser.password;
                    existing.role = seedUser.role;
                    existing.permissions = seedUser.permissions;
                    existing.name = seedUser.name || existing.name;
                    updated = true;
                  }
                }
              });
              if (updated) {
                localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(localUsers));
              }
            }
          } catch (e) {
            localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(DEFAULT_SEED_USERS));
          }
        }
      }
    }

    loadSession() {
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(STORAGE_KEY_AUTH_USER);
          if (raw) return JSON.parse(raw);
        }
      } catch (e) {
        console.warn('[EventPayAuth] ไม่สามารถโหลดเซสชันผู้ใช้ได้:', e);
      }
      return null;
    }

    saveSession(user) {
      this.currentUser = user;
      try {
        if (typeof localStorage !== 'undefined') {
          if (user) {
            localStorage.setItem(STORAGE_KEY_AUTH_USER, JSON.stringify(user));
          } else {
            localStorage.removeItem(STORAGE_KEY_AUTH_USER);
          }
        }
      } catch (e) {}
    }

    getCurrentUser() {
      if (!this.currentUser) {
        this.currentUser = this.loadSession();
      }
      return this.currentUser;
    }

    getUsers() {
      const db = this._getDB();
      if (db) {
        let list = db.getAll(COLLECTION_USERS);
        if (!list || list.length === 0) {
          if (typeof db._healLegacyUsers === 'function') {
            db._healLegacyUsers();
            list = db.getAll(COLLECTION_USERS);
          } else {
            this._seedUsersIfEmpty();
            list = db.getAll(COLLECTION_USERS);
          }
        }
        return (list && list.length > 0) ? list : DEFAULT_SEED_USERS;
      }
      if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem('eventpay_db_' + COLLECTION_USERS);
          const parsed = raw ? JSON.parse(raw) : [];
          if (parsed && parsed.length > 0) return parsed;
        } catch (e) { }
      }
      return DEFAULT_SEED_USERS;
    }

    getUser(userId) {
      const users = this.getUsers();
      return users.find(u => u.user_id === userId || u.username === userId) || null;
    }

    createUser(userData) {
      if (!userData.username || !userData.password) {
        throw new Error('กรุณาระบุ Username และ Password ให้ครบถ้วน');
      }
      const cleanUsername = String(userData.username).trim().toLowerCase();
      const existing = this.getUsers().find(u => u.username.toLowerCase() === cleanUsername);
      if (existing) {
        throw new Error(`ชื่อผู้ใช้ "${cleanUsername}" มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น`);
      }

      const newUser = {
        user_id: 'USER-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase(),
        username: cleanUsername,
        password: String(userData.password).trim(),
        name: userData.name || cleanUsername,
        role: userData.role || 'STAFF',
        permissions: {
          booking: !!(userData.permissions && userData.permissions.booking),
          index: !!(userData.permissions && userData.permissions.index),
          kiosk: !!(userData.permissions && userData.permissions.kiosk),
          admin: !!(userData.permissions && userData.permissions.admin)
        },
        created_at: new Date().toISOString()
      };

      const db = this._getDB();
      if (db) {
        db.insert(COLLECTION_USERS, newUser);
        db.logAudit('CREATE_USER', 'SECURITY', `สร้างผู้ใช้งานใหม่: ${newUser.username} (${newUser.role})`, this.getCurrentUser()?.username || 'SYSTEM');
      } else if (typeof localStorage !== 'undefined') {
        const users = this.getUsers();
        users.push(newUser);
        localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(users));
      }

      return newUser;
    }

    updateUser(userId, updates) {
      const db = this._getDB();
      const users = this.getUsers();
      const user = users.find(u => u.user_id === userId);
      if (!user) {
        throw new Error('ไม่พบผู้ใช้งานที่ระบุ');
      }

      // ป้องกันการปิดสิทธิ์ admin ของตัวเองจนเข้าไม่ได้
      if (user.username === 'admin' && updates.permissions && !updates.permissions.admin) {
        throw new Error('ไม่สามารถยกเลิกสิทธิ์ Admin ของบัญชีหลักได้');
      }

      const cleanUpdates = {};
      if (updates.name !== undefined) cleanUpdates.name = updates.name;
      if (updates.role !== undefined) cleanUpdates.role = updates.role;
      if (updates.password && String(updates.password).trim()) {
        cleanUpdates.password = String(updates.password).trim();
      }
      if (updates.permissions) {
        cleanUpdates.permissions = {
          booking: !!updates.permissions.booking,
          index: !!updates.permissions.index,
          kiosk: !!updates.permissions.kiosk,
          admin: !!updates.permissions.admin
        };
      }

      let updated = null;
      if (db) {
        updated = db.update(COLLECTION_USERS, userId, cleanUpdates, 'user_id');
        db.logAudit('UPDATE_USER', 'SECURITY', `อัปเดตข้อมูลผู้ใช้งาน: ${user.username}`, this.getCurrentUser()?.username || 'SYSTEM');
      } else if (typeof localStorage !== 'undefined') {
        const idx = users.findIndex(u => u.user_id === userId);
        if (idx !== -1) {
          users[idx] = { ...users[idx], ...cleanUpdates };
          localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(users));
          updated = users[idx];
        }
      }

      // หากผู้ใช้ที่กำลังแก้คือคนที่ล็อกอินอยู่ ให้อัปเดตเซสชัน
      if (this.currentUser && this.currentUser.user_id === userId && updated) {
        this.saveSession(updated);
      }

      return updated;
    }

    deleteUser(userId) {
      const user = this.getUser(userId);
      if (!user) throw new Error('ไม่พบผู้ใช้งานที่ต้องการลบ');
      if (user.username === 'admin') {
        throw new Error('ไม่สามารถลบบัญชีผู้ดูแลระบบหลัก (admin) ได้');
      }

      const db = this._getDB();
      let success = false;
      if (db) {
        success = db.delete(COLLECTION_USERS, userId, 'user_id');
        db.logAudit('DELETE_USER', 'SECURITY', `ลบผู้ใช้งาน: ${user.username}`, this.getCurrentUser()?.username || 'SYSTEM');
      } else if (typeof localStorage !== 'undefined') {
        let users = this.getUsers();
        users = users.filter(u => u.user_id !== userId);
        localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(users));
        success = true;
      }

      // ถ้าลบคนที่กำลังล็อกอินอยู่ ให้เด้งออก
      if (this.currentUser && this.currentUser.user_id === userId) {
        this.logout();
      }
      return success;
    }

    login(username, password) {
      const normalize = str => String(str || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const cleanUsername = normalize(username);
      const cleanPassword = String(password || '').trim();

      const users = this.getUsers();
      let user = users.find(u => normalize(u.username) === cleanUsername && String(u.password).trim() === cleanPassword);

      // [INSERTED ACTIVE LOGIC: THEP-APAI MASTER ACCOUNT AUTO-HEAL ON LOGIN]
      // หากยังไม่พบบัญชีที่ตรงกัน ให้ตรวจสอบเทียบกับ 5 บัญชีทางการของเทพอภัย
      // หากกรอกรหัสทางการถูกต้อง ให้ทำการ Self-Heal ซ่อมแซมและอัปเกรดข้อมูลในเครื่องให้เข้าใช้งานได้ทันที 100%
      if (!user) {
        const seedUser = DEFAULT_SEED_USERS.find(s => normalize(s.username) === cleanUsername && String(s.password).trim() === cleanPassword);
        if (seedUser) {
          const db = this._getDB();
          if (db) {
            const existing = db.getAll(COLLECTION_USERS).find(u => normalize(u.username) === cleanUsername);
            if (existing) {
              db.update(COLLECTION_USERS, existing.user_id, {
                password: seedUser.password,
                role: seedUser.role,
                permissions: seedUser.permissions,
                name: seedUser.name || existing.name
              });
              user = db.get(COLLECTION_USERS, existing.user_id) || seedUser;
            } else {
              db.insert(COLLECTION_USERS, seedUser);
              user = seedUser;
            }
          } else if (typeof localStorage !== 'undefined') {
            try {
              let localUsers = this.getUsers();
              const existingIdx = localUsers.findIndex(u => normalize(u.username) === cleanUsername);
              if (existingIdx !== -1) {
                localUsers[existingIdx].password = seedUser.password;
                localUsers[existingIdx].role = seedUser.role;
                localUsers[existingIdx].permissions = seedUser.permissions;
                user = localUsers[existingIdx];
              } else {
                localUsers.push(seedUser);
                user = seedUser;
              }
              localStorage.setItem('eventpay_db_' + COLLECTION_USERS, JSON.stringify(localUsers));
            } catch (e) {
              user = seedUser;
            }
          } else {
            user = seedUser;
          }
        }
      }

      if (!user) {
        return { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
      }

      this.saveSession(user);
      const db = this._getDB();
      if (db) {
        db.logAudit('LOGIN_SUCCESS', 'AUTH', `ผู้ใช้งาน ${user.username} เข้าสู่ระบบสำเร็จ`, user.username);
      }

      return { success: true, user };
    }

    logout() {
      const user = this.getCurrentUser();
      const db = this._getDB();
      if (db && user) {
        db.logAudit('LOGOUT', 'AUTH', `ผู้ใช้งาน ${user.username} ออกจากระบบ`, user.username);
      }
      this.saveSession(null);
      if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
        window.location.reload();
      }
    }

    hasPermission(portalKey) {
      const user = this.getCurrentUser();
      if (!user) return false;
      if (user.username === 'admin') return true;
      if (user.permissions && user.permissions[portalKey] === true) return true;
      return false;
    }

    // ========================================================================
    // UI PROTECTION & INJECTION
    // ========================================================================

    protectPage(portalKey) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;

      const portalNames = {
        booking: 'การจองบัตรออนไลน์ (booking.html)',
        index: 'เคาน์เตอร์จำหน่ายบัตร (index.html)',
        kiosk: 'ประตูคัดกรอง Kiosk (kiosk.html)',
        admin: 'แดชบอร์ดผู้บริหาร (admin.html)'
      };

      // สำหรับหน้า booking ให้ลูกค้าทั่วไปเข้าได้ แต่สามารถมีปุ่มสลับไปหน้าเจ้าหน้าที่
      if (portalKey === 'booking') {
        this._updateUserBadgeInHeader();
        return;
      }

      const user = this.getCurrentUser();

      // กรณีที่ 1: ยังไม่ได้เข้าสู่ระบบ
      if (!user) {
        this._renderLoginOverlay(portalKey, portalNames[portalKey]);
        return;
      }

      // กรณีที่ 2: เข้าสู่ระบบแล้ว แต่ไม่มีสิทธิ์ในหน้านี้
      if (!this.hasPermission(portalKey)) {
        this._renderAccessDeniedOverlay(user, portalKey, portalNames[portalKey]);
        return;
      }

      // กรณีที่ 3: สิทธิ์ถูกต้อง
      this._updateUserBadgeInHeader();
    }

    _updateUserBadgeInHeader() {
      const user = this.getCurrentUser();
      const userContainers = document.querySelectorAll('.ep-auth-user-badge-container');
      
      const badgeHtml = user ? `
        <div class="ep-auth-badge" style="display: inline-flex; align-items: center; gap: 8px; background: rgba(16, 185, 129, 0.15); border: 1px solid var(--accent-green); padding: 4px 10px; border-radius: 20px; font-size: 0.78rem;">
          <span style="color: var(--accent-green); font-weight: 700;">👤 ${user.name}</span>
          <span style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 10px; color: var(--accent-gold); font-size: 0.7rem;">${user.role}</span>
          <button type="button" onclick="EventPayAuth.logout()" style="background: none; border: none; color: #f87171; cursor: pointer; font-size: 0.75rem; text-decoration: underline; padding: 0 4px;" title="ออกจากระบบ">
            [ออก]
          </button>
        </div>
      ` : `
        <button type="button" onclick="EventPayAuth.showLoginModal()" class="ep-nav-btn" style="font-size: 0.75rem; padding: 4px 10px; background: rgba(6, 182, 212, 0.15); border-color: var(--accent-cyan); color: var(--accent-cyan);">
          🔑 เข้าสู่ระบบเจ้าหน้าที่
        </button>
      `;

      userContainers.forEach(c => {
        c.innerHTML = badgeHtml;
      });
    }

    _renderLoginOverlay(portalKey, portalName) {
      let overlay = document.getElementById('epAuthModalOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'epAuthModalOverlay';
        overlay.className = 'ep-auth-overlay';
        document.body.appendChild(overlay);
      }

      overlay.innerHTML = `
        <div class="ep-auth-card">
          <div style="margin-bottom: 18px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
            <img src="assets/ice-logo-new.jpg" 
                 alt="Ice Pro Sound Logo" 
                 style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2.5px solid #38bdf8; box-shadow: 0 4px 14px rgba(0,0,0,0.45); display: block; margin-bottom: 10px;" 
                 onerror="this.src='assets/ice-logo.jpg'">
            <h2 style="color: #60a5fa; font-size: 1.2rem; font-weight: 800; margin: 0; letter-spacing: 0.5px; line-height: 1.2;">
              บริษัท ไอซ์ โปรซาวด์ จำกัด
            </h2>
            <p style="color: var(--text-muted); font-size: 0.82rem; margin: 5px 0 0 0;">
              เข้าสู่ระบบความปลอดภัย EventPay
            </p>
          </div>

          <div id="epAuthAlert" style="display: none; background: rgba(239, 68, 68, 0.2); border: 1px solid #ef4444; color: #fca5a5; padding: 8px 12px; border-radius: 6px; font-size: 0.82rem; margin-bottom: 14px;"></div>

          <form id="epAuthLoginForm" onsubmit="event.preventDefault(); EventPayAuth.handleLoginSubmit('${portalKey}');">
            <div style="text-align: left; margin-bottom: 14px;">
              <label style="display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">ชื่อผู้ใช้ (Username)</label>
              <input type="text" id="epAuthUsername" class="ep-auth-input" placeholder="เช่น admin, cashier, gate" required autofocus />
            </div>

            <div style="text-align: left; margin-bottom: 20px;">
              <label style="display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">รหัสผ่าน (Password)</label>
              <input type="password" id="epAuthPassword" class="ep-auth-input" placeholder="กรอกรหัสผ่าน" required />
            </div>

            <button type="submit" class="ep-btn-submit" style="padding: 12px; font-size: 1rem;">
              🔓 เข้าสู่ระบบทันที
            </button>
          </form>

          <div style="margin-top: 16px;">
            <a href="booking.html" style="font-size: 0.78rem; color: var(--text-muted); text-decoration: none; opacity: 0.85; transition: opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.85'">
              ← กลับหน้าหลักจองตั๋วออนไลน์
            </a>
          </div>
        </div>
      `;
      overlay.style.display = 'flex';
    }

    _renderAccessDeniedOverlay(user, portalKey, portalName) {
      let overlay = document.getElementById('epAuthModalOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'epAuthModalOverlay';
        overlay.className = 'ep-auth-overlay';
        document.body.appendChild(overlay);
      }

      overlay.innerHTML = `
        <div class="ep-auth-card" style="border-color: #ef4444;">
          <div style="font-size: 2.2rem; margin-bottom: 8px;">⛔</div>
          <h2 style="color: #ef4444; font-size: 1.25rem; font-weight: 800; margin-bottom: 6px;">
            สิทธิ์การเข้าถึงถูกจำกัด (Access Denied)
          </h2>
          <p style="color: #fca5a5; font-size: 0.88rem; margin-bottom: 16px;">
            ผู้ใช้งาน <strong>"${user.name}"</strong> (${user.username})<br/>
            ไม่มีสิทธิ์เข้าใช้งานหน้า: <strong>${portalName}</strong>
          </p>

          <div style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; margin-bottom: 20px; text-align: left; font-size: 0.8rem;">
            <div style="font-weight: 700; color: #fff; margin-bottom: 6px;">หน้าต่างที่คุณสามารถเข้าใช้งานได้ตามสิทธิ์:</div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              ${user.permissions.booking ? '<a href="booking.html" style="color: var(--accent-cyan);">📱 จองบัตรออนไลน์ (booking.html)</a>' : ''}
              ${user.permissions.index ? '<a href="index.html" style="color: var(--accent-green);">🎫 จำหน่ายบัตรหน้างาน (index.html)</a>' : ''}
              ${user.permissions.kiosk ? '<a href="kiosk.html" style="color: #a78bfa;">🚪 ประตูคัดกรอง Kiosk (kiosk.html)</a>' : ''}
              ${user.permissions.admin ? '<a href="admin.html" style="color: var(--accent-gold);">📊 แดชบอร์ด Admin (admin.html)</a>' : ''}
            </div>
          </div>

          <div style="display: flex; gap: 10px;">
            <button type="button" onclick="EventPayAuth.logout()" class="ep-nav-btn" style="flex: 1; padding: 10px; background: #ef4444; color: #fff; border: none; font-weight: 700;">
              🚪 เปลี่ยนบัญชีผู้ใช้
            </button>
            <a href="booking.html" class="ep-nav-btn" style="flex: 1; padding: 10px; background: #1e293b; text-align: center; font-weight: 700; text-decoration: none;">
              หน้าหลัก
            </a>
          </div>
        </div>
      `;
      overlay.style.display = 'flex';
    }

    handleLoginSubmit(portalKey) {
      const uInput = document.getElementById('epAuthUsername');
      const pInput = document.getElementById('epAuthPassword');
      const alertBox = document.getElementById('epAuthAlert');

      if (!uInput || !pInput) return;

      const res = this.login(uInput.value, pInput.value);
      if (!res.success) {
        if (alertBox) {
          alertBox.textContent = '❌ ' + res.message;
          alertBox.style.display = 'block';
        }
        return;
      }

      // ตรวจสิทธิ์สำหรับหน้านี้
      if (!this.hasPermission(portalKey)) {
        this._renderAccessDeniedOverlay(res.user, portalKey, portalKey);
        return;
      }

      // ผ่านฉลุย ปิด overlay และรีเฟรชหน้า
      const overlay = document.getElementById('epAuthModalOverlay');
      if (overlay) overlay.style.display = 'none';
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    }

    showLoginModal() {
      this._renderLoginOverlay('admin', 'ระบบเจ้าหน้าที่');
    }

    _injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('epAuthGuardStyles')) return;

      const style = document.createElement('style');
      style.id = 'epAuthGuardStyles';
      style.innerHTML = `
        .ep-auth-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(3, 7, 18, 0.92);
          backdrop-filter: blur(8px);
          z-index: 999999;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .ep-auth-card {
          background: #0f172a;
          border: 1px solid var(--accent-cyan, #06b6d4);
          border-radius: 16px;
          padding: 28px 24px;
          max-width: 420px;
          width: 100%;
          text-align: center;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.7);
          animation: epAuthPop 0.25s ease-out;
        }
        @keyframes epAuthPop {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        .ep-auth-input {
          width: 100%;
          background: #070d1a;
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: #fff;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 0.95rem;
          outline: none;
          box-sizing: border-box;
        }
        .ep-auth-input:focus {
          border-color: var(--accent-gold, #f59e0b);
        }
        .ep-perm-pill {
          display: inline-block;
          font-size: 0.7rem;
          padding: 2px 6px;
          border-radius: 4px;
          margin-right: 4px;
          margin-bottom: 2px;
          font-weight: 700;
        }
        .ep-perm-yes { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981; }
        .ep-perm-no { background: rgba(239, 68, 68, 0.1); color: #64748b; border: 1px solid rgba(255,255,255,0.06); }
      `;
      document.head.appendChild(style);
    }
  }

  return new AuthGuardEngine();
}));
