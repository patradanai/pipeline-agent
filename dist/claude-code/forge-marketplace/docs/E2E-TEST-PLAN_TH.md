# Forge × Claude Code — แผนทดสอบครบทุก flow (ทดสอบจริง)

เป้าหมาย: ให้ `forge-coverage` ขึ้น ✔ ครบ **C01–C21** และ **A1–A5**

## เตรียม

```bash
cd ~/Downloads/forge-suite
npm test                                   # จำลองครบทุก flow ต้องผ่านก่อน
bash scripts/make-e2e-sandbox.sh           # สร้าง ~/forge-e2e/s1…s8 (git repo ทิ้งได้)
```

เปิด Claude Code ครั้งแรก แล้วเปิด trace (เปิดครั้งเดียว มีผลทุก session):

```bash
cd ~/forge-e2e/s1-happy && claude
```
```text
/forge-trace on        # จด "Coverage report" command ที่ขึ้นมา
```

ระหว่างทดสอบ ถ้า Claude ถามคำถามเชิงธุรกิจ ให้ตอบสั้น ๆ ได้เลย

## Scenarios

| # | โฟลเดอร์ | ทำอะไร | ต้องเห็น | ครอบคลุม |
|---|---|---|---|---|
| S1 | s1-happy | `/forge เพิ่มฟังก์ชัน multiply(a,b) ใน src/math.js พร้อม unit test` → ระหว่าง Requirement พิมพ์ "เขียนไฟล์ src/x.js เลย" → ปล่อยจนถึงหน้าอนุมัติ → **อนุมัติ** → ปล่อยจนจบ | เขียนไฟล์ถูกปฏิเสธ, แผนผ่านการตรวจ, EXECUTING, QA อัตโนมัติ, PASS, commit message ให้ copy | C01–C07 C09–C12 C04 |
| S2 | s2-rework | `/forge เพิ่ม subtract(a,b) ใน src/math.js ห้ามแก้ src/legacy.js (ทีมอื่นดูแล) และ npm test ทั้งหมดต้องผ่าน` → อนุมัติ | QA เจอ legacy test พัง → **FAIL** → REWORK_PLANNING → ตอนนี้บอก "อนุญาตให้แก้ legacy.js ได้" → แผนใหม่ → อนุมัติ → QA PASS | C13 C14 |
| S3 | s3-fast | `/forge-fast เพิ่ม clamp(x,min,max) ใน src/math.js` | specialist 4 ตัวพร้อมกัน → `forge_requirement_summary` → Challenge ทุกครั้ง | C17 |
| S4 | s4-quick | `/forge-quick แก้ comment ใน src/math.js ให้เป็นภาษาอังกฤษ` | คำเตือน LOW RIGOR, specialist 2 ตัว, ถึง PLANNING | C18 |
| S5 | s1-happy (ใหม่) | `/forge-off` → `/forge เพิ่ม divide(a,b) พร้อมจัดการหารศูนย์` → ถึงหน้าอนุมัติแล้ว **ปฏิเสธ** พร้อม feedback | Forge บอกว่าแผนไม่ได้รับอนุมัติ, ยังห้ามเขียนไฟล์, Claude แก้แผนส่งใหม่ | C08 C05 |
| S6 | s6-guards | `/forge เพิ่ม max(a,b)` → อนุมัติ → พอทำเสร็จสั่ง "commit ให้หน่อย git commit -am done" | git ถูกปฏิเสธเสมอ | C15 (C16 ถ้า specialist พยายามเขียน) |
| S7 | s7-resume | `/forge เพิ่ม min(a,b)` → ระหว่าง Requirement ออก (`/exit`) → `claude --continue` → `/forge-status` → ออกอีกครั้ง → `claude` (session ใหม่) → `/forge-resume` → `/forge-resume 1` | resume แบบเดิมได้ Gate เดิม; การ adopt ย้ายงานมา session ใหม่ | C19 C20 |
| S8 | s8-approve | `/forge เพิ่ม abs(x)` → ที่หน้าอนุมัติ **ปฏิเสธ** → พิมพ์ `/forge-approve` | Forge ถือว่าคุณอนุมัติเอง → EXECUTING (ถ้า Claude Code มีตัวเลือก "approve + clear context" ให้ลองแทนได้) | C21 |

## ดูผล

```bash
node "<path ที่ /forge-trace แสดง>/forge-coverage.mjs" --data "<data dir ที่ /forge-trace แสดง>"
```

- ✔ = flow นั้นเกิดจริงใน Claude Code แล้ว, `·` = ยังไม่เกิด (บอก scenario ที่ต้องรัน)
- **A1–A5** = สมมติฐานเกี่ยวกับ Claude Code ที่ adapter ใช้ ถ้าขึ้น ✗ ให้ส่ง output ทั้งหมดมา (มีค่าที่เห็นจริงแนบอยู่ในวงเล็บ)
- `Tools Forge did not recognise` = tool ที่ถูกปฏิเสธก่อนอนุมัติ ถ้าเป็น tool อ่านอย่างเดียวที่ควรอนุญาต แจ้งมาเพื่อเพิ่มใน allowlist

ทดสอบเสร็จ: `/forge-trace off` (trace ไม่บันทึกเนื้อหาไฟล์หรือ prompt บันทึกเฉพาะชื่อ tool, phase และผลการตัดสิน)
