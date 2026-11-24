# OMP Forge v6.2 — Plan mode แบบ OMP, main agent ทำงานเอง

## ติดตั้งทับเวอร์ชันเดิม

```bash
cd ~/Downloads
unzip omp-forge-global-v6.1.0.zip
cd omp-forge-global-v6.1.0
bash ./install.sh
```

ปิด OMP แล้วเปิดใหม่ เลือก Session ที่มีงาน Forge ด้วย OMP `/resume` หรือ `/forge resume` จาก Main Session.

Forge ใช้ 3 gate: `PLAN`, `EXECUTE`, `QA` (delivery อยู่ใน QA หลัง PASS) โดยต้องได้รับการอนุมัติแผนจากผู้ใช้ในหน้าต่างอนุมัติของ Forge ก่อนเริ่ม Execute แถบสถานะแสดง `FORGE ▰▱▱ Planning 1/3` / `Plan review 1/3`, `▰▰▱ Execution 2/3`, `▰▰▰ QA review 3/3` / `Delivery 3/3`

ตรวจสอบด้วย:

```
/forge status
```

Forge ยังคงใช้หน้าต่างอนุมัติของ Forge, Gate Skills, agent `forge-code-reviewer` ตอน QA (และ `forge-plan-critic` เมื่อเปิด plan review) และไม่ทำ git commit/push เอง.

Plan critic (ไม่บังคับ): `/forge planreview on|off` ค่าเริ่มต้น OFF บันทึกใน config ของ Forge และมีผลกับ workflow ใหม่ (แต่ละงานจำค่าไว้ตอนเริ่ม) ดูได้จาก `/forge status` (`plan review: ON/OFF`) เมื่อเปิด main ต้องรัน `forge-plan-critic` (อ่านอย่างเดียว รายงาน `PC-001 [HIGH] …`) 1 ครั้งกับแผนที่เขียนแล้วก่อนส่ง Forge ปฏิเสธ `forge_plan_propose` จนกว่า critic รายงานแล้ว และแผนอ้าง PC-id ระดับ CRITICAL/HIGH ครบทุกข้อ

### Gate Skills ที่ติดตั้งมาพร้อม Forge

แพ็กเกจติดตั้ง `forge-plan-gate`, `forge-execute-gate` และ `forge-qa-gate` ลงใน `~/.omp/agent/skills/<ชื่อ>/SKILL.md` หรือ `$PI_CODING_AGENT_DIR/skills/<ชื่อ>/SKILL.md` เมื่อกำหนดตัวแปรนี้ Forge แนบ skill ของแต่ละ gate (planning, execution, qa, delivery) ให้ main agent และยังใช้ skill เพิ่มเติมที่ผู้ใช้ตั้งค่าได้ผ่าน `/forge skill` และ `/forge skill list`

Installer ไม่เขียนทับโฟลเดอร์ skill ชื่อเดียวกันที่มีอยู่ จึงรักษาการปรับแต่งของผู้ใช้ไว้ ยกเว้น gate skill เวอร์ชันเก่าที่ยังอ้าง agent ที่ถูกเลิกใช้: installer สำรองไว้ใน `forge-backups/` แล้วติดตั้งไฟล์ใหม่แทน หากต้องการใช้ไฟล์จากแพ็กเกจกับ skill อื่น ให้สำรองและย้ายโฟลเดอร์เดิมออกก่อนติดตั้งใหม่

QA: main agent เรียก `forge_qa_scope` แล้วสั่ง `forge-code-reviewer` รีวิว diff ขนานกับการรัน check ของแผน ตรวจทุก TC เอง แล้วส่ง `forge_qa_submit` ครั้งเดียว reviewer รายงานบรรทัดละ finding `CR-001 [HIGH] file:line — evidence — fix` และ CR-id ระดับ CRITICAL/HIGH ทุกข้อต้องอยู่ใน codeReview.findings: คงระดับ CRITICAL/HIGH (gate FAIL) หรือ evidence ขึ้นต้นด้วย `Disputed:` พร้อมหลักฐานแย้ง (ลดระดับได้ แต่ยังแสดงในรายงาน QA) ไม่งั้น Forge ไม่รับผล หลังบันทึก QA PASS แล้ว main agent จัดทำรายงานและข้อความ commit ผ่าน `forge_delivery_submit` เอง โดยไม่ stage, commit หรือ push

หลัง `forge_qa_submit` ทุกครั้ง Forge แสดงตารางสรุป QA ใน TUI (ไม่ส่งให้ model): หัว `Forge QA ✅ PASS / ❌ FAIL / ⚠️ BLOCKED` พร้อมจำนวนและ path รายงานเต็ม, TC ที่อนุมัติทีละแถว (สถานะ ✅ ❌ ⚠️ ⏸️, test case, business topic, scenario, actual, evidence), ตาราง quality gate, finding ของ code review (🔴 CRITICAL 🟠 HIGH 🟡 MEDIUM ⚪ LOW) และสิ่งที่ทำให้ gate ไม่ผ่าน

QA FAIL/BLOCKED ไม่เริ่มแก้เอง Forge รอคุณตัดสินใจ แถบสถานะขึ้น `QA failed · your decision` / `QA blocked · your decision` และระหว่างรอ Forge บล็อกการเขียนแผน การเสนอแผน และการส่ง QA ซ้ำ เมื่อ turn ของ QA จบ จะเปิดหน้าต่างให้เลือก:

- FAIL: **Plan the fix — draft a rework plan, then approve it**, **Plan the fix with my notes** (โน้ตที่พิมพ์จะถูกแนบไปกับคำสั่ง rework), **Not now — keep the QA report** (เก็บทุกอย่างไว้)
- BLOCKED: มี **Rerun QA — I collected the missing evidence** เป็นตัวเลือกแรก แล้วตามด้วยตัวเลือกเดียวกับ FAIL
- `/forge review` แสดงตารางอีกครั้งและเปิดหน้าต่างตัดสินใจใหม่ `/forge rework` และ `/forge qa` ก็ใช้ตัดสินใจได้เช่นกัน
- หลังเลือกวางแผนแก้ แผน rework ยังต้องผ่านการอนุมัติแผนตามปกติก่อนแก้โค้ด (คนตัดสินใจ 2 จุด)

---

## Steering: พิมพ์ prompt ระหว่าง Forge ทำงาน

ถ้าผู้ใช้พิมพ์ prompt ขณะ workflow ยังทำงานอยู่ (prompt ที่ไม่ขึ้นต้นด้วย `/`) Forge จะเด้งหน้าต่าง `Forge steering · prompt "…" from user` ให้เลือก 2 ทาง

- **`Steer · <gate เดิม> → PLAN · <ผล>`**: บันทึก prompt เป็น requirement steering แล้วกลับไปที่ PLAN เสมอ ตามตารางด้านล่าง ถ้า turn ที่กำลังรันยังไม่จบ Forge จะหยุด turn นั้นทันที เพราะงานที่เหลือไม่ใช้แล้ว (ประหยัด token และเวลา) จากนั้นแจ้ง `Forge steering #N · <from> → <to> · prompt "…" from user`
- **`Cancel · keep working on <gate>`**: state ไม่เปลี่ยน งานเดิมทำต่อ และ prompt กลับไปอยู่ในช่องพิมพ์

| พิมพ์ระหว่าง | ผลเมื่อเลือก Steer |
|---|---|
| PLAN | ถอนแผนที่เสนอไว้ แล้ว main agent แก้แผนเดิมแบบ delta (ID เดิมคงไว้) |
| EXECUTE / QA (รวม QA PASS ก่อนส่งมอบ) | ยกเลิกการอนุมัติ แผนเดิมกลายเป็นฐาน rework แบบอ่านอย่างเดียว main agent แก้เฉพาะส่วนที่ steering เปลี่ยน แล้วต้องอนุมัติใหม่ Forge ไม่สร้างรายงาน QA BLOCKED ปลอม และ subagent ที่ยังรันอยู่แก้ไฟล์ต่อไม่ได้ |

steering ทุกข้ออยู่ใน state และแนบไปกับคำสั่ง Planning และ Rework ทุกครั้ง ไม่มีการตัดข้อเก่าทิ้งเมื่อเกิน 20 ข้อ จึงรักษา requirement เดิมเมื่อ resume หรือ compact ข้อความ prompt ส่งให้ model ครั้งเดียวต่อคำสั่ง ไม่ซ้ำ ดูจำนวน steering ได้จาก `/forge status` (`steering: N`) และแถบสถานะ (`Steering N`) ประวัติที่ยาวขึ้นจะเพิ่ม context ที่ต้องใช้

## v6.2: Plan mode แบบ OMP, main agent ทำงานเอง

Gate Requirement และ agent `forge-requirement`, `forge-planner`, `forge-executor`, `forge-qa`, `forge-delivery` ถูกเอาออก เหลือ 3 gate

- PLAN: main agent สำรวจเอง (read/grep/glob และ `scout` หลายตัวขนานกัน) ถามด้วย ask เมื่อจำเป็น เขียน `local://<slug>-plan.md` ทีละส่วน (Context / Approach / Critical files & anchors / Verification / Assumptions & contingencies + Business Topics, Requirement Traceability, Business Test Cases, Code Quality Gates) แล้วส่งด้วย `forge_plan_propose` working tree อ่านอย่างเดียว เขียนได้แค่ไฟล์แผน (write หรือ edit ที่ไม่มี REM/MV) ถ้าจบ turn โดยไม่ ask หรือไม่ propose Forge เตือน 2 ครั้ง แล้วขึ้นคำเตือน
- Forge ปฏิเสธแผนที่ขาด `## Context`, `## Approach`, `## Verification` หรือ `## Assumptions & contingencies` และใน Approach ต้องมีบรรทัด `Open decisions:` (`none` หรือข้อย่อยละเรื่องพร้อม `default: …` ข้อที่มีคำว่า BLOCKER ถูกปฏิเสธ ต้องถามผู้ใช้ก่อน) กับ `Migration & rollback:` (ขั้นตอน หรือ `not applicable — <เหตุผล>`)
- EXECUTE: main agent ลงมือเองตามแผน (todo ทีละขั้น แบ่งงานให้ subagent ได้)
- QA: main agent ตรวจเองคู่กับ `forge-code-reviewer` 1 ตัว แล้วทำ delivery เอง
- `install.sh` ติดตั้ง `forge-code-reviewer` และ `forge-plan-critic` และย้าย agent ที่เลิกใช้ (`forge-critic`, `forge-architect`, `forge-qa-strategist`, `forge-requirement`, `forge-planner`, `forge-executor`, `forge-qa`, `forge-delivery`) กับ skill `forge-requirement-gate` ไปไว้ใน `forge-backups/`
- checkpoint เก่าที่ค้างอยู่ใน REQUIREMENT จะกลับมาเป็น PLAN แบบยังไม่อนุมัติ
- install.sh ไม่เขียนทับ `forge-code-reviewer.md`/`forge-plan-critic.md` ที่มีอยู่ ถ้าขึ้น `NOTE: your installed forge-code-reviewer differs…` ให้เทียบกับไฟล์ใหม่ หรือรัน `FORGE_REINSTALL_AGENTS=1 bash install.sh` (มี backup)

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
