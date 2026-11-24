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

รีสตาร์ท Claude Code แล้วตรวจ `/hooks` (มี hook ของ Forge), `/mcp` (มี server `forge`), `/agents` (มี agent `forge:` 6 ตัว) ต้องมี `node` 22 ขึ้นไป

## ใช้งาน

```text
/forge สร้างระบบอนุมัติการจองห้อง     # เริ่มงาน
/forge status                          # ดู Gate ปัจจุบัน
/forge approve                         # อนุมัติเองเมื่อ context ถูกล้างจน Forge ไม่เห็นการอนุมัติ
/forge planreview on                   # เปิด plan critic สำหรับงานใหม่ (ค่าเริ่มต้น off)
/forge off                             # ยกเลิก
```

พิมพ์ `/forge` แล้วเลือกจากเมนูได้เลย: `/forge-status`, `/forge-resume`, `/forge-approve`, `/forge-qa`, `/forge-rework`, `/forge-delivery`, `/forge-planreview`, `/forge-off` ฯลฯ

ลำดับ: Claude เข้า plan mode สำรวจโค้ดเอง (ใช้ `Explore` แบบอ่านอย่างเดียวได้) ถามด้วย AskUserQuestion เมื่อจำเป็น เขียนแผน แล้วเรียก **ExitPlanMode** พร้อมแผนเต็ม → Forge ตรวจ plan contract ก่อน → **คุณกดอนุมัติในหน้าต่างของ Claude Code** → Claude ลงมือเอง → เมื่อ Claude จะหยุด Forge สั่ง QA (Claude ตรวจทุก TC + `forge:forge-code-reviewer` รีวิว diff ขนานกัน) → QA PASS → Claude ทำ Delivery พร้อม commit message ให้ copy

plan contract: แผนต้องมี `## Context`, `## Approach`, `## Verification`, `## Assumptions & contingencies` และส่วน BIZ/REQ/TC/QG ใน Approach ต้องมีบรรทัด `Open decisions:` (`none` หรือข้อย่อยพร้อม `default: …` ข้อที่มี BLOCKER ถูกปฏิเสธ ต้องถามก่อน) และ `Migration & rollback:` (ขั้นตอน หรือ `not applicable — <เหตุผล>`) เมื่อเปิด plan review (`/forge-planreview on`, ดูใน `/forge status` เป็น `plan review: ON/OFF`) Claude ต้องรัน `forge:forge-plan-critic` 1 ครั้งก่อน และอ้าง PC-id ระดับ CRITICAL/HIGH ทุกข้อในแผน

QA: reviewer รายงาน `CR-001 [HIGH] file:line — evidence — fix` และ CR-id ระดับ CRITICAL/HIGH ทุกข้อต้องอยู่ใน `forge_qa_submit` คงระดับเดิม (QA FAIL) หรือขึ้นต้น evidence ด้วย `Disputed:` พร้อมหลักฐานแย้ง ไม่งั้น Forge ไม่รับผล

หลังส่งผล QA ทุกครั้ง Claude ต้องพิมพ์ตารางสรุปของ Forge ตามนั้นทุกตัวอักษร: หัว `Forge QA ✅ PASS / ❌ FAIL / ⚠️ BLOCKED` พร้อมจำนวนและ path รายงาน, TC ทีละแถว (✅ ❌ ⚠️ ⏸️), quality gate, finding ของ review (🔴 🟠 🟡 ⚪) และสิ่งที่ทำให้ gate ไม่ผ่าน ถ้า FAIL/BLOCKED Forge ไม่แก้เอง แต่รอคุณตัดสินใจ (`QA failed · your decision` / `QA blocked · your decision`) และระหว่างรอจะบล็อกการเขียนแผน ExitPlanMode และการส่ง QA ซ้ำ: พิมพ์ `/forge-rework` เพื่อวางแผนแก้ (แผนแก้ต้องอนุมัติตามปกติก่อนแก้โค้ด), `/forge-qa` เพื่อรัน QA ใหม่เมื่อ BLOCKED หรือ `/forge-off`

Forge ไม่รัน git add/commit/push เอง และไม่เขียนไฟล์ลงโปรเจกต์ รายงานทั้งหมดอยู่ใน data dir ของ plugin

## ควรตรวจในการใช้งานครั้งแรก

ตัว plugin ทดสอบกับรูปแบบ JSON ของ hook ตามเอกสาร Claude Code แต่ยังไม่ได้รันใน Claude Code จริง ให้ลองงานเล็ก ๆ ก่อน แล้วดู `/forge status` ว่าจำนวน `waiting agents` ลดลงหลัง `forge-code-reviewer` รายงานใน QA ถ้าไม่ลด ให้ส่งผล `/forge status` กับ `/hooks` มา

## Resume

- **กลับไป session เดิม (approval ยังอยู่ครบ):** ใช้ resume ของ Claude Code เอง `claude --resume <session>`, `claude --continue` หรือ `/resume` Forge จะบอก Claude ว่าอยู่ Gate ไหน
- **ดึงงานจาก session อื่นของโปรเจกต์เดียวกัน:** `/forge-resume` แสดงรายการ, `/forge-resume <เลข>` ดึงมาไว้ใน session นี้ งานที่อนุมัติแล้วจะกลับไปที่ PLANNING และต้องกดอนุมัติใหม่ session ต้นทางจะถูกปิด ไม่ให้มีงานซ้ำ 2 ที่
- เปิด session ใหม่ในโปรเจกต์ที่มีงาน Forge ค้าง Claude จะได้รับแจ้งให้บอกคุณเรื่อง `/forge-resume`
