/**
 * ============================================================================
 * EVENTPAY AUDIO ALERT ENGINE (js/audioAlertEngine.js)
 * โครงการ: EventPay (โครงการระบบโอนและเงินสด รับเงิน-จ่ายเงิน งานคอนเสิร์ต)
 * พิกัด: D:\BillingApp\Antigravity\EventPay\js\audioAlertEngine.js
 * สถาปัตยกรรม: Web Audio API Synthesizer (Zero External Audio File Dependency)
 * มาตรฐาน: Notifications.md & SKILL.md
 * ============================================================================
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EventPayAudioAlert = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class EventPayAudioAlert {
    constructor() {
      this.ctx = null;
      this.isAlarmRunning = false;
      this.alarmOscillator = null;
      this.alarmGain = null;
      this.alarmLfo = null;
      this.alarmLfoGain = null;
      this.isUnlocked = false;
    }

    /**
     * กำหนดค่าและเตรียม AudioContext พร้อมรองรับ Autoplay Policy Bypass
     */
    init() {
      if (!this.ctx && typeof window !== 'undefined') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.ctx = new AudioCtx();
        }
      }

      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => {
          this.isUnlocked = true;
        }).catch((err) => {
          console.warn('[EventPay Audio] AudioContext resume failed:', err);
        });
      } else if (this.ctx && this.ctx.state === 'running') {
        this.isUnlocked = true;
      }
      return this.ctx;
    }

    /**
     * ปลดล็อก AudioContext ผ่านการกดปุ่มหรือสัมผัสหน้าจอครั้งแรก (User Interaction)
     */
    unlockAudio() {
      this.init();
      if (!this.ctx) return Promise.resolve(false);

      if (this.ctx.state === 'suspended') {
        return this.ctx.resume().then(() => {
          this.isUnlocked = true;
          // เล่นเสียงเงียบ 0.01 วินาที เพื่อการันตีการปลดล็อกระบบเสียงบน Android Kiosk
          this._playSilentBuffer();
          return true;
        }).catch((err) => {
          console.warn('[EventPay Audio] Unlock failed:', err);
          return false;
        });
      }

      this._playSilentBuffer();
      this.isUnlocked = true;
      return Promise.resolve(true);
    }

    _playSilentBuffer() {
      if (!this.ctx) return;
      try {
        const buffer = this.ctx.createBuffer(1, 1, 22050);
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.ctx.destination);
        source.start(0);
      } catch (e) {
        // Ignored
      }
    }

    /**
     * 1. เสียงผ่าน (Success Chime)
     * Sine wave นุ่มนวล 523.25Hz (C5) -> 659.25Hz (E5) ระยะเวลา 0.25 วินาที
     * ใช้สำหรับ: สแกนผ่าน, ข้อมูลถูกต้อง, บันทึกเงินสำเร็จ
     */
    playSuccessChime() {
      this.init();
      if (!this.ctx) return;

      try {
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now); // โน้ต C5
        osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.12); // สไลด์ขึ้นไป E5

        // ซองเสียง (Envelope) ค่อยๆ ดังแล้วจางลงอย่างนุ่มนวล
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.35, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.30);
      } catch (err) {
        console.error('[EventPay Audio] playSuccessChime error:', err);
      }
    }

    /**
     * 2. เสียงเตือนระดับกลาง (Warning Beep)
     * Triangle wave 440Hz (A4) 2 จังหวะสั้นๆ
     * ใช้สำหรับ: เตือนรอตรวจสอบสลิป, จำนวนเงินไม่ตรง, แจ้งเตือนทั่วไป
     */
    playWarningBeep() {
      this.init();
      if (!this.ctx) return;

      try {
        const now = this.ctx.currentTime;
        [0, 0.14].forEach((delay) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(440, now + delay);

          gain.gain.setValueAtTime(0.001, now + delay);
          gain.gain.linearRampToValueAtTime(0.4, now + delay + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.10);

          osc.connect(gain);
          gain.connect(this.ctx.destination);

          osc.start(now + delay);
          osc.stop(now + delay + 0.12);
        });
      } catch (err) {
        console.error('[EventPay Audio] playWarningBeep error:', err);
      }
    }

    /**
     * 3. เสียงไซเรนเตือนภัยฉุกเฉิน (Loudspeaker Alarm Siren)
     * Sawtooth wave ความถี่สูง 800Hz - 1600Hz กวาดขึ้นลงต่อเนื่อง (Wailing Siren)
     * ใช้สำหรับ: สแกนซ้ำ (สวมสิทธิ์), ริสต์แบนด์ไม่ตรง, บัตรโมฆะ, ส่งออกลำโพงภายนอก Kiosk
     */
    startAlarmSiren() {
      if (this.isAlarmRunning) return; // ทำงานอยู่แล้ว
      this.init();
      if (!this.ctx) return;

      try {
        const now = this.ctx.currentTime;

        // เมนออสซิลเลเตอร์คลื่นฟันเลื่อย คมชัด ทะลุทะลวงเสียงดังในงานคอนเสิร์ต
        this.alarmOscillator = this.ctx.createOscillator();
        this.alarmOscillator.type = 'sawtooth';
        this.alarmOscillator.frequency.setValueAtTime(800, now);

        // LFO (Low-Frequency Oscillator) คลุมความถี่ให้กวาดขึ้นลง 800Hz <-> 1600Hz ที่ความเร็ว 2.5Hz
        this.alarmLfo = this.ctx.createOscillator();
        this.alarmLfo.type = 'sine';
        this.alarmLfo.frequency.setValueAtTime(2.5, now);

        this.alarmLfoGain = this.ctx.createGain();
        this.alarmLfoGain.gain.setValueAtTime(400, now); // กวาดความถี่ +/- 400Hz รอบ 1200Hz

        this.alarmOscillator.frequency.setValueAtTime(1200, now);
        this.alarmLfo.connect(this.alarmOscillator.frequency);

        // เมนเกน (Gain) ระดับความดังสูงสุด 0.85
        this.alarmGain = this.ctx.createGain();
        this.alarmGain.gain.setValueAtTime(0.001, now);
        this.alarmGain.gain.linearRampToValueAtTime(0.85, now + 0.08);

        this.alarmOscillator.connect(this.alarmGain);
        this.alarmGain.connect(this.ctx.destination);

        this.alarmLfo.start(now);
        this.alarmOscillator.start(now);
        this.isAlarmRunning = true;
      } catch (err) {
        console.error('[EventPay Audio] startAlarmSiren error:', err);
      }
    }

    /**
     * หยุดเสียงไซเรนเตือนภัยฉุกเฉินทันที
     */
    stopAlarmSiren() {
      if (!this.isAlarmRunning || !this.ctx) return;

      try {
        const now = this.ctx.currentTime;
        if (this.alarmGain) {
          this.alarmGain.gain.cancelScheduledValues(now);
          this.alarmGain.gain.setValueAtTime(this.alarmGain.gain.value, now);
          this.alarmGain.gain.linearRampToValueAtTime(0.001, now + 0.05);
        }

        setTimeout(() => {
          if (this.alarmOscillator) {
            try { this.alarmOscillator.stop(); } catch (e) { /* ignore */ }
            this.alarmOscillator.disconnect();
            this.alarmOscillator = null;
          }
          if (this.alarmLfo) {
            try { this.alarmLfo.stop(); } catch (e) { /* ignore */ }
            this.alarmLfo.disconnect();
            this.alarmLfo = null;
          }
          if (this.alarmGain) {
            this.alarmGain.disconnect();
            this.alarmGain = null;
          }
          this.isAlarmRunning = false;
        }, 60);
      } catch (err) {
        console.error('[EventPay Audio] stopAlarmSiren error:', err);
        this.isAlarmRunning = false;
      }
    }
  }

  return EventPayAudioAlert;
}));
