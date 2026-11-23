# Forge · เอกสารภาษาไทย
**English:** [README](README.md) · [คู่มือผู้ใช้](docs/USER_GUIDE.md) · [Custom skills (OMP)](docs/CUSTOM_SKILLS.md) · [ติดตั้ง](docs/INSTALL.md) · [ความปลอดภัย](docs/SECURITY.md)

**Forge** ทำให้ AI เขียนโค้ดอย่างมีขั้นตอนแบบทีมจริง: วิเคราะห์ requirement → วางแผน → **คุณอนุมัติ** → ลงมือ → QA อิสระ → ส่งมอบ
แต่ละขั้นมี agent เฉพาะทางทำหน้าที่ของตัวเอง และ Forge จะไม่ยอมให้ข้ามขั้น

ใช้ได้กับ **Claude Code** (plugin) และ **Oh My Pi / OMP** (extension) โดยใช้ core เดียวกัน

![Forge workflow](docs/images/workflow.svg)

## ทำไมต้อง Forge

- **ไม่แก้ implementation ก่อนอนุมัติ** — agent แก้ไฟล์งานได้หลังคุณอนุมัติแผนเท่านั้น
- **ตรวจได้ทุกข้อ** — แผนต้องมี Business Topic (BIZ), Requirement (REQ), Test Case (TC) และ Quality Gate (QG) ที่ QA ใช้ตรวจย้อนได้ทีละข้อ
- **QA ไม่เชื่อคำพูด** — test ที่ไม่ได้รันจริงต้องเป็น `NOT_RUN` ถ้า QA ไม่ผ่าน ต้องทำแผนแก้และอนุมัติใหม่
- **Git เป็นของคุณ** — agent ห้าม `git add/commit/push` และห้าม publish ทุกขั้น Forge แค่ร่าง commit message ให้ copy

## Agents ทั้ง 6 ตัว

![Forge agents](docs/images/agents.svg)

| Agent | Gate | หน้าที่ | สิทธิ์ |
|---|---|---|---|
| `forge-requirement` | 1 | วิเคราะห์ Requirement รอบเดียวครบทุกมุม: เป้าหมาย ขอบเขต เกณฑ์ยอมรับ ช่องโหว่/กรณีที่จะพัง สถาปัตยกรรมพร้อม tradeoff แผนทดสอบ แล้วท้าทายร่างของตัวเองก่อนส่ง | อ่านอย่างเดียว |
| `forge-planner` | 2 | แตกงานย่อย ลำดับงาน rollback และโครง BIZ/REQ/TC/QG | อ่านอย่างเดียว |
| `forge-executor` | 4 | เขียนโค้ดตามแผนที่อนุมัติเท่านั้น (ไม่มี shell, ไม่แตะ Git) | **แก้ไฟล์ได้** |
| `forge-qa` | 5 | ตรวจทุก TC เทียบพฤติกรรมจริงกับแผน | อ่านอย่างเดียว |
| `forge-code-reviewer` | 5 | รีวิวความถูกต้อง ความปลอดภัย ประสิทธิภาพ พร้อม file:line | อ่านอย่างเดียว |
| `forge-delivery` | 6 | สรุปงาน วิธี rollout/rollback และร่าง commit message | อ่านอย่างเดียว |

Gate 1 ใช้ agent ตัวเดียว รอบเดียว: `forge-requirement` ครอบคลุม 6 มุม (intake, ช่องว่าง, critique, สถาปัตยกรรม, กลยุทธ์ทดสอบ, self-challenge) → main ตรวจรายงานซ้ำแบบผู้อ่านอิสระ แล้วส่ง `forge_requirement_summary` → Planning

## คำสั่ง

พิมพ์ `/forge` ใน Claude Code แล้วเลือกจากเมนูได้เลย (ใน OMP ใช้ `/forge <คำสั่งย่อย>` เช่น `/forge status`)

| คำสั่ง | ใช้เมื่อ |
|---|---|
| `/forge <requirement>` | เริ่มงานใหม่ |
| `/forge-status` | ดูว่าอยู่ Gate ไหน และกำลังรอ agent ตัวไหน |
| `/forge-plan` | ดู path ของแผนที่ส่งอนุมัติ |
| `/forge-approve` | อนุมัติแผนเอง เมื่อ Forge มองไม่เห็นการอนุมัติ (เช่น context ถูกล้าง) |
| `/forge-qa` | เริ่มหรือรัน QA ใหม่ |
| `/forge-rework` | ทำแผนแก้ไขหลัง QA ไม่ผ่าน (ต้องอนุมัติใหม่) |
| `/forge-delivery` | ดู commit message หรือทำขั้นส่งมอบต่อ |
| `/forge-report` | ดู path รายงาน QA ล่าสุด |
| `/forge-resume [เลข]` | ดูงาน Forge ใน session อื่นของโปรเจกต์นี้ หรือดึงมาทำต่อ |
| `/forge-agents` | รายชื่อ agent |
| `/forge-trace [on\|off]` | บันทึก event สำหรับทดสอบ flow (ดู [แผนทดสอบ](docs/E2E-TEST-PLAN_TH.md)) |
| `/forge-off` | ยกเลิกงาน (ไม่แก้ไฟล์ ไม่แตะ Git) |

AI เรียกคำสั่งเหล่านี้แทนคุณไม่ได้ ทุกคำสั่งต้องพิมพ์เอง

## Requirement Gate รอบเดียว

เดิม Gate 1 ใช้ agent 4 ตัว 3 รอบต่อกัน (7 ครั้ง) แต่ละตัวสำรวจโค้ดซ้ำเอง และ main ต้องสรุปคั่นทุกรอบ ตอนนี้เหลือ `forge-requirement` รันครั้งเดียว:

| สิ่งที่รักษาคุณภาพไว้ | ทำอย่างไร |
|---|---|
| ครบทุกมุมเหมือนเดิม | prompt ของ `forge-requirement` รวมหน้าที่ analyst, critic, architect, QA strategist และ challenge ไว้ครบ และคำสั่ง Gate บังคับให้ main ส่ง checklist 6 มุมไปในงานทุกครั้ง |
| ยังมีรอบท้าทาย | agent ต้องท้าทายร่างของตัวเอง (counterexample กับทุก CRITICAL/HIGH และทุกทางเลือกสถาปัตยกรรม) แล้วบอกว่าแก้อะไร |
| ยังมีผู้อ่านคนที่สอง | main ตรวจรายงานซ้ำก่อนสรุป เพิ่ม finding ที่ agent พลาด (source `orchestrator`) |
| ห้ามตัดความเสี่ยงทิ้ง | Forge ปฏิเสธสรุปที่ไม่มี CRITICAL/HIGH ถ้ารายงานของ agent มี |
| Planner ได้ baseline เดียวกันเสมอ | สรุปถูกเก็บใน state และแนบเข้าคำสั่ง Planning |

สิ่งที่เสียไป: critic ไม่ได้แยกเป็น agent อิสระแล้ว (self-challenge + main ตรวจซ้ำแทน)

## ค่าใช้ token

Forge ใช้หลาย agent จึงกิน token มากกว่าการสั่ง Claude ตรง ๆ เลือกระดับโมเดลตอน build ได้ (ไม่ลดขั้นตอน ลดแค่โมเดล) ใช้ได้ทั้ง Claude Code และ OMP:

| `FORGE_MODELS` | opus | sonnet | haiku |
|---|---|---|---|
| `rigor` (ค่าเริ่มต้น) | requirement, planner | qa, code-reviewer | executor, delivery |
| `balanced` | requirement, planner, qa, code-reviewer | executor | delivery |
| `economy` | — | 5 ตัว | delivery |

`forge-requirement` ใช้ opus ทั้งใน `rigor` และ `balanced` เพราะรับงาน critic ไปด้วย

OMP: build ใส่ `model:` ให้ไฟล์ `forge-*.md` ตาม profile (เช่น `anthropic/claude-opus-5-5, opus` คือลอง id เต็มก่อน แล้ว fallback เป็น alias) แก้ต่อได้ใน OMP `/agents` ส่วน `install.sh` จะไม่ทับไฟล์ agent ที่ติดตั้งไว้แล้ว ถ้าต้องการโมเดลใหม่ให้รัน `FORGE_REINSTALL_AGENTS=1 bash install.sh` (สำรองไฟล์เดิมไว้ใน `forge-backups/`)

```bash
FORGE_MODELS=balanced npm test
```

Forge ไม่ยอมให้ specialist ตัวเดิมรันซ้ำใน Gate เดียวกัน (กำลังรันอยู่ หรือรายงานแล้ว) เพื่อตัดค่าใช้จ่ายที่ไม่ได้เพิ่มความครอบคลุม

## ตัวอย่าง 1 รอบ

```text
/forge เพิ่มฟังก์ชันคำนวณอายุจากวันเกิด พร้อม unit test
```

1. `forge-requirement` วิเคราะห์รอบเดียว แล้ว Claude ตรวจรายงานซ้ำและส่งสรุป (`forge_requirement_summary`)
2. `forge-planner` วางแผน แล้ว Claude ส่งแผนเข้าหน้าอนุมัติ (Forge ตรวจรูปแบบแผนก่อน)
3. **คุณอ่านแผนแล้วกดอนุมัติ**
4. `forge-executor` เขียนโค้ด แล้ว main รัน test
5. `forge-qa` + `forge-code-reviewer` ตรวจ ถ้าไม่ผ่าน กลับไปทำแผนแก้
6. `forge-delivery` สรุปงาน และให้ commit message — คุณ review diff แล้ว commit เอง

## ตัวอย่างเครื่องคำนวณอายุ

รันโปรแกรมด้วยวันเกิดรูปแบบ `YYYY-MM-DD` เช่น:

```bash
node examples/age-calculator.mjs 2000-02-29
```

โปรแกรมแสดงอายุเต็มเป็นปี โดยใช้วันที่ปัจจุบันตามเขตเวลาท้องถิ่นของเครื่อง วันที่ต้องเป็นวันจริงตามปฏิทินเกรกอเรียนและใช้ปี ค.ศ. 4 หลัก หากเกิดวันที่ 29 กุมภาพันธ์ วันครบรอบในปีที่ไม่ใช่ปีอธิกสุรทินจะเป็นวันที่ 1 มีนาคม

## ติดตั้ง

```bash
npm test                       # build + ทดสอบ (Node 22+)
```

**Claude Code**
```bash
mkdir -p ~/.claude/marketplaces && cp -R dist/claude-code/forge-marketplace ~/.claude/marketplaces/
claude plugin marketplace add ~/.claude/marketplaces/forge-marketplace
claude plugin install forge@forge-local
```

**OMP**
```bash
cd dist/omp/omp-forge-global-v*/ && bash ./install.sh
```

แผน รายงาน QA และเอกสารส่งมอบถูกเก็บนอกโปรเจกต์ตาม data directory ของ host ส่วนโค้ดจะถูกแก้ในโปรเจกต์หลังอนุมัติแผนแล้ว ตรวจ diff ก่อนรวมงานเสมอ

## เอกสารเพิ่มเติม

- [โครงสร้างโค้ดและการ build](docs/DEVELOPMENT.md)
- [สถาปัตยกรรม core + adapter](docs/ARCHITECTURE.md)
- [แผนทดสอบใน Claude Code จริง](docs/E2E-TEST-PLAN_TH.md)
- [Claude Code plugin](adapters/claude-code/README.md)
- [Custom Skills สำหรับ OMP พร้อมตัวอย่างและภาพ Flow](docs/CUSTOM_SKILLS.md)

## License

Repository นี้ยังไม่มีไฟล์ `LICENSE` การเปิด repository เป็น public ไม่ได้แปลว่าอนุญาตให้นำโค้ดไปใช้หรือเผยแพร่ต่อ ต้องเพิ่ม license ก่อนให้สิทธิ์ reuse หรือเปิดรับ contribution
