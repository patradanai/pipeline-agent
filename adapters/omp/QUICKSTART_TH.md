# OMP Forge v5.26 — Requirement รอบคอบเป็นหลัก

## ติดตั้งทับ v5.25 / v5.24

```bash
cd ~/Downloads
unzip omp-forge-global-v5.26.zip
cd omp-forge-global-v5.26
bash ./install.sh
```

ปิด OMP แล้วเปิดใหม่ เลือก Session ที่มีงาน Forge ด้วย OMP `/resume` หรือ `/forge resume` จาก Main Session.

หลังอนุมัติ Plan และเข้า Execution แถบสถานะด้านล่างควรแสดง `FORGE Execution 3/5` จาก OMP Native Footer; เมื่อเข้า QA จะเปลี่ยนเป็น `FORGE QA review 4/5`.

ตรวจสอบด้วย:

```
/forge status
```

Forge ยังคงใช้ Native OMP Approval, Gate Skills, 9 Agents และไม่ทำ git commit/push เอง.

---

## v5.26: โหมด Requirement (รอบคอบเป็นค่าเริ่มต้น)

| โหมด | Subagent | ความรอบคอบ |
|---|---|---|
| `thorough` (ค่าเริ่มต้น) | 7 ครบทุกตัว | เต็ม — DISCOVERY → COOKING 4 ตัวพร้อมกัน → CHALLENGE 2 ตัวพร้อมกัน |
| `fast` (`/forge --fast …`) | 6 | ครบทุกมุมมอง + Challenge ทุกครั้ง แต่ Main ทำ intake แทน discovery agent |
| `quick` (`/forge quick …`) | 2 | **ต่ำ** — มีคำเตือน ใช้กับงานเล็กมากเท่านั้น |

ความเร็วที่ได้ใน thorough มาจาก 2 อย่างที่ไม่ลดความรอบคอบ:
- critic กับ architect ใน Challenge รันพร้อมกัน แต่ยังเป็นอิสระต่อกัน (ไม่เห็นรายงานของอีกฝ่าย)
- ทุก specialist ได้ baseline และรายชื่อไฟล์ชุดเดียวกันจาก Discovery เป็นจุดเริ่ม ไม่ต้องสำรวจใหม่ แต่ยังอ่านเพิ่มได้ตามจำเป็น

ใน fast/quick ถ้า specialist รายงาน CRITICAL/HIGH แต่สรุปไม่มี Forge จะปฏิเสธสรุปนั้น

ถ้าเคยตั้ง `/forge mode fast` ใน v5.25 ไว้ ค่านั้นยังอยู่ ใช้ `/forge mode thorough` เพื่อกลับเป็นค่าเริ่มต้น

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
