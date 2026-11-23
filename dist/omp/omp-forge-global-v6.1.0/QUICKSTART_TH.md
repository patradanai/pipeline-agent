# OMP Forge v6.1 — Requirement รอบเดียว agent เดียว

## ติดตั้งทับเวอร์ชันเดิม

```bash
cd ~/Downloads
unzip omp-forge-global-v6.1.0.zip
cd omp-forge-global-v6.1.0
bash ./install.sh
```

ปิด OMP แล้วเปิดใหม่ เลือก Session ที่มีงาน Forge ด้วย OMP `/resume` หรือ `/forge resume` จาก Main Session.

Forge ใช้ 4 gate: `REQUIREMENT`, `PLAN`, `EXECUTE`, `QA` โดยต้องได้รับ Native OMP Approval จากผู้ใช้ก่อนเริ่ม Execute

ตรวจสอบด้วย:

```
/forge status
```

Forge ยังคงใช้ Native OMP Approval, Gate Skills, 6 Agents และไม่ทำ git commit/push เอง.

### Gate Skills ที่ติดตั้งมาพร้อม Forge

แพ็กเกจติดตั้ง `forge-requirement-gate`, `forge-plan-gate`, `forge-execute-gate` และ `forge-qa-gate` ลงใน `~/.omp/agent/skills/<ชื่อ>/SKILL.md` หรือ `$PI_CODING_AGENT_DIR/skills/<ชื่อ>/SKILL.md` เมื่อกำหนดตัวแปรนี้ Forge แนบ skill ของแต่ละ gate ให้ workflow และยังใช้ skill เพิ่มเติมที่ผู้ใช้ตั้งค่าได้ผ่าน `/forge skill` และ `/forge skill list`

Installer ไม่เขียนทับโฟลเดอร์ skill ชื่อเดียวกันที่มีอยู่ จึงรักษาการปรับแต่งของผู้ใช้ไว้ หากต้องการใช้ไฟล์จากแพ็กเกจ ให้สำรองและย้ายโฟลเดอร์เดิมออกก่อนติดตั้งใหม่

QA ตรวจโดย `forge-qa` และ `forge-code-reviewer` อย่างอิสระ หลังบันทึก QA PASS แล้ว `forge-delivery` จัดทำรายงานและข้อความ commit สำหรับผู้ใช้ โดยไม่ stage, commit หรือ push เอง หาก QA ไม่ผ่าน ต้องวางแผนแก้ไขและขออนุมัติใหม่

---

## Steering: พิมพ์ prompt ระหว่าง Forge ทำงาน

ถ้าผู้ใช้พิมพ์ prompt ขณะ workflow ยังทำงานอยู่ (prompt ที่ไม่ขึ้นต้นด้วย `/`) Forge จะเด้งหน้าต่าง `Forge steering · prompt "…" from user` ให้เลือก 2 ทาง

- **`Steer · <gate เดิม> → <gate ใหม่> · <ผล>`**: บันทึก prompt เป็น requirement steering แล้วกลับไปที่ gate ตามตารางด้านล่าง ถ้า turn ที่กำลังรันยังไม่จบ Forge จะหยุด turn นั้นทันที เพราะงานที่เหลือไม่ใช้แล้ว (ประหยัด token และเวลา) จากนั้นแจ้ง `Forge steering #N · <from> → <to> · prompt "…" from user`
- **`Cancel · keep working on <gate>`**: state ไม่เปลี่ยน งานเดิมทำต่อ และ prompt กลับไปอยู่ในช่องพิมพ์

| พิมพ์ระหว่าง | ผลเมื่อเลือก Steer |
|---|---|
| REQUIREMENT | `forge-requirement` รันใหม่แบบ delta: ได้รายงานเดิมไปด้วย และตรวจเฉพาะส่วนที่ steering เปลี่ยน รายงานเดิมเก็บไว้เป็น audit |
| PLAN | ถอนแผนที่เสนอไว้ แล้ว `forge-planner` แก้แผนเดิมแบบ delta (ID เดิมคงไว้) |
| EXECUTE / QA (รวม QA PASS ก่อนส่งมอบ) | ยกเลิกการอนุมัติ แผนเดิมกลายเป็นฐาน rework แบบอ่านอย่างเดียว planner แก้เฉพาะส่วนที่ steering เปลี่ยน แล้วต้องอนุมัติใหม่ Forge ไม่สร้างรายงาน QA BLOCKED ปลอม และ executor ที่ยังรันอยู่แก้ไฟล์ต่อไม่ได้ |

steering ทุกข้ออยู่ใน state และแนบไปกับคำสั่ง Requirement, Planning และ Rework ทุกครั้ง ไม่มีการตัดข้อเก่าทิ้งเมื่อเกิน 20 ข้อ จึงรักษา requirement เดิมเมื่อ resume หรือ compact ข้อความ prompt ส่งให้ model ครั้งเดียวต่อคำสั่ง ไม่ซ้ำ ดูจำนวน steering ได้จาก `/forge status` (`steering: N`) และแถบสถานะ (`Steering N`) ประวัติที่ยาวขึ้นจะเพิ่ม context ที่ต้องใช้

## v6.1: Requirement รอบเดียว agent เดียว

Gate 1 เหลือ `forge-requirement` รันครั้งเดียว (เดิม 4 agent 3 รอบ รวม 7 ครั้ง) แล้ว Main ตรวจรายงานซ้ำและส่ง `forge_requirement_summary` เพื่อเข้า Planning

- agent ตัวเดียวครอบคลุม 6 มุม: intake, ช่องว่าง, critique, สถาปัตยกรรม, กลยุทธ์ทดสอบ และท้าทายร่างของตัวเอง
- Main อ่านรายงานซ้ำแบบผู้อ่านอิสระ เพิ่ม finding ที่ agent พลาด และ Forge ปฏิเสธสรุปที่ตัด CRITICAL/HIGH ของรายงานทิ้ง
- `/forge mode`, `/forge quick …`, `/forge --fast …`, `/forge thorough …` ถูกเอาออก (พิมพ์ `/forge quick …` ตอนนี้คือ requirement ธรรมดา)
- `install.sh` ย้าย `forge-critic`, `forge-architect`, `forge-qa-strategist` ที่ติดตั้งไว้ไปไว้ใน `forge-backups/` (OMP `/agents` จะไม่แสดงอีก)
- install.sh ไม่เขียนทับ `forge-requirement.md` ที่มีอยู่ ถ้าขึ้น `NOTE: forge-requirement now runs the whole Requirement gate…` ให้เทียบกับไฟล์ใหม่ หรือรัน `FORGE_REINSTALL_AGENTS=1 bash install.sh` (มี backup)

## v5.24: "Approve and execute" แล้ว Forge ไม่หาย

OMP v19 เมื่อกด **Approve and execute** จะเปิด **Session ใหม่** (ล้าง Context) แล้วรันแผนในนั้น v5.24 จะพา Forge ตามไปด้วย:

- หลังกดอนุมัติ แถบสถานะใน Session ใหม่ต้องขึ้น `FORGE Execution 3/5` และ `/forge status` ขึ้น `EXECUTING`
- ถ้า Session ใหม่เปิดก่อนผลอนุมัติมาถึง จะขึ้น `AWAITING_APPROVAL` ชั่วครู่ (ยังห้ามแก้ไฟล์) แล้วเปลี่ยนเป็น `EXECUTING` เองจากผลอนุมัติของ OMP
- จะไม่ตามไปถ้าเป็น `/new` ธรรมดา, กด Refine/Dismiss, หรืออนุมัติไว้นานเกิน 60 วินาที

## v5.23: อนุมัติแล้วไม่หลุด State อีก

**ปกติ (ไม่ต้องทำอะไร):** ถ้า OMP เปลี่ยน Session Branch ทันทีหลังกดอนุมัติ Plan (ภายใน 15 วินาที ใน Session เดิม) Forge จะพา Approval ที่เพิ่งกดไปยัง Branch ใหม่ให้อัตโนมัติ และ `/forge status` ต้องขึ้น `EXECUTING` ไม่ต้องกู้และไม่ต้องอนุมัติซ้ำ

การส่งต่อนี้ใช้ได้ครั้งเดียว อยู่ในหน่วยความจำของ OMP เท่านั้น (ไม่อ่านจากไฟล์) และจะไม่ทำงานถ้า Branch ใหม่มี State ของ Forge อยู่แล้ว (รวมถึงสถานะยกเลิก) หรือถ้ากด Refine/Dismiss แทนการอนุมัติ

**กรณีต้องกู้ (`RECOVERY_AVAILABLE`):** เช่น เปิด Branch อื่นทีหลัง หรือรีสตาร์ท OMP

```text
/forge status
/forge recover
```

- ระหว่างที่ยังไม่ได้ตัดสินใจ Forge จะ **หยุดการแก้ไฟล์ / Shell / Subagent** บน Branch นี้ไว้ (อ่านไฟล์ได้) และบล็อก Git write เสมอ แถบสถานะจะขึ้น `Recovery needed (edits paused)`
- เลือก **Recover** → กลับไปที่ `PLANNING` อย่างปลอดภัย ต้องกด Native Approval ใหม่ก่อน Execute
- เลือก **Keep this branch inactive** → แก้ไฟล์ได้ตามปกติ แต่ Git write ยังถูกบล็อก
- ถ้ามีหลาย Workflow ใน Session เดียวกัน Popup จะแสดง Requirement และเวลาที่บันทึก พร้อมตัวเลือก Workflow ที่เก่ากว่า
- Workflow ที่ค้างในสถานะ `*_BLOCKED` กู้ได้แล้ว

ถ้าต้องการรักษา Approval เดิมโดยไม่อนุมัติใหม่ ให้กลับไปยัง Branch ต้นทางผ่าน `/resume` ของ OMP แล้วตรวจ `/forge status`

`/forge off` จะยกเลิกเฉพาะ Workflow ปัจจุบันและไม่ถูกเสนอให้กู้อีก

## ไฟล์ Checkpoint สำรอง (ไม่ใช่ Project)

```text
~/.omp/agent/forge-checkpoints/<session-fingerprint>.json
```

Local JSON (โฟลเดอร์ 0700, ไฟล์ 0600) มี Requirement และ Workflow State ไม่ควรอัปโหลดหรือแชร์โดยไม่ตรวจก่อน ไฟล์ที่ไม่ถูกแตะเกิน 30 วันจะถูกลบอัตโนมัติตอนเปิด OMP

การติดตั้งใหม่ไม่ลบ Checkpoint เดิม ไม่เขียนทับ Agent ที่แก้ไว้ใน OMP `/agents` และถ้าเคยรัน `uninstall.sh` ไว้ `install.sh` จะคืน Agent ที่คุณแก้ไว้ (`*.disabled.*`) แทนการลงค่า Default ทับ

หากไม่เห็น `RECOVERY_AVAILABLE` ให้ตรวจว่าเปิด Session/Branch ที่ถูกต้องและไฟล์ Session เดิมยังอยู่ หรือใช้ `/resume` ของ OMP เลือก Session เดิมโดยตรง อย่าใช้ `/forge off` ใน Session ที่ต้องการกู้
