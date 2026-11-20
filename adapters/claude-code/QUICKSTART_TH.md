# Forge สำหรับ Claude Code — เริ่มใช้งาน

## ติดตั้ง

```bash
cd forge-suite
npm run build
```

ใน Claude Code:

```text
/plugin marketplace add /path/เต็ม/forge-suite/dist/claude-code/forge-marketplace
/plugin install forge@forge-local
```

รีสตาร์ท Claude Code แล้วตรวจ `/hooks` (มี hook ของ Forge), `/mcp` (มี server `forge`), `/agents` (มี agent `forge:` 9 ตัว) ต้องมี `node` 22 ขึ้นไป

## ใช้งาน

```text
/forge สร้างระบบอนุมัติการจองห้อง     # thorough (ค่าเริ่มต้น)
/forge status                          # ดู Gate ปัจจุบัน
/forge approve                         # อนุมัติเองเมื่อ context ถูกล้างจน Forge ไม่เห็นการอนุมัติ
/forge off                             # ยกเลิก
```

พิมพ์ `/forge` แล้วเลือกจากเมนูได้เลย: `/forge-status`, `/forge-resume`, `/forge-approve`, `/forge-qa`, `/forge-rework`, `/forge-delivery`, `/forge-mode`, `/forge-quick`, `/forge-fast`, `/forge-thorough`, `/forge-off` ฯลฯ

ลำดับ: Requirement (specialist ผ่าน Agent tool) → Planner → Claude เข้า plan mode แล้วเรียก **ExitPlanMode** พร้อมแผนเต็ม → Forge ตรวจ plan contract ก่อน → **คุณกดอนุมัติในหน้าต่างของ Claude Code** → Executor ลงมือ → เมื่อ Claude จะหยุด Forge สั่ง QA อิสระ → QA PASS → Delivery พร้อม commit message ให้ copy

Forge ไม่รัน git add/commit/push เอง และไม่เขียนไฟล์ลงโปรเจกต์ รายงานทั้งหมดอยู่ใน data dir ของ plugin

## ควรตรวจในการใช้งานครั้งแรก

ตัว plugin ทดสอบกับรูปแบบ JSON ของ hook ตามเอกสาร Claude Code แต่ยังไม่ได้รันใน Claude Code จริง ให้ลองงานเล็ก ๆ ก่อน แล้วดู `/forge status` ว่าจำนวน `waiting agents` ลดลงหลัง specialist แต่ละตัวทำงานเสร็จ ถ้าไม่ลด ให้ส่งผล `/forge status` กับ `/hooks` มา

## Resume

- **กลับไป session เดิม (approval ยังอยู่ครบ):** ใช้ resume ของ Claude Code เอง `claude --resume <session>`, `claude --continue` หรือ `/resume` Forge จะบอก Claude ว่าอยู่ Gate ไหน
- **ดึงงานจาก session อื่นของโปรเจกต์เดียวกัน:** `/forge-resume` แสดงรายการ, `/forge-resume <เลข>` ดึงมาไว้ใน session นี้ งานที่อนุมัติแล้วจะกลับไปที่ PLANNING และต้องกดอนุมัติใหม่ session ต้นทางจะถูกปิด ไม่ให้มีงานซ้ำ 2 ที่
- เปิด session ใหม่ในโปรเจกต์ที่มีงาน Forge ค้าง Claude จะได้รับแจ้งให้บอกคุณเรื่อง `/forge-resume`
