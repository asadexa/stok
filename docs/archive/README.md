# Arşiv

Buradaki dosyalar **güncel gerçek değildir**. Tarihsel gerekçe, eski inceleme
sonuçları ve projenin nasıl evrildiğini anlamak için okunur; değiştirilmez.
Çelişki durumunda kod ve yaşayan dosyalar kazanır (`PROJECT_BRAIN`,
`CURRENT_STATE`, `DECISIONS`, `TODOS`, `docs/SECURITY_MODEL.md`, `docs/designs/`).

| Dosya | Ne | Arşive giriş |
|---|---|---|
| `PLAN-2026-09.md` | Eski yaşayan plan: CEO/Eng/Design/CI incelemeleri, tehdit modelinin ilk hali, T1–T119, üretime hazırlık denetimi | 2026-10-08 (eski `PLAN.md`; kökte artık yalnız yönlendirici var) |
| `TODOS-2026-08.md` | İlk TODOS: ertelenen E-maddelerinin uzun gerekçeleri | 2026-10-08 (eski `TODOS.md`) |

Her dosyanın başına bir uyarı bloğu eklendi; gövde orijinalle birebir aynı.
Fiyat defteri tasarımı (`docs/designs/fiyat-defteri.md`) T90/T91 için hâlâ aktif
olduğundan arşive alınmadı; o işler kapanınca buraya taşınır.

## 2026-10-08 göç haritası (eski → yeni)

| Eski yer | Yeni yer |
|---|---|
| PLAN §0 kararlar ve teknoloji seçimi | `DECISIONS` PRD-01/03, ARC-07; `PROJECT_BRAIN` §1, §14. Gerçek teknoloji listesi `README` (Next 15, shadcn/ui, bwip-js satırları eskidi) |
| PLAN §1 veri modeli, değiştirilemezlik, RLS, miktar/para tipleri | `PROJECT_BRAIN` §6, §8; `DECISIONS` DAT-01/02/10, SEC-01; ADR-001/002 |
| PLAN §2 mimari, eşzamanlılık, veri akışı, offline okuma | `PROJECT_BRAIN` §5–§6 (INV-5); ARC-10, ARC-13. Outbox durum makinesi ve ölçeklenme tablosu yalnız burada (ADR-003) |
| PLAN §2 geri alma, §9 dağıtım | `docs/uretim-runbook.md`; DAT-13, ARC-09, ARC-13, OPS-03 |
| PLAN §3 hata haritası, G1–G4, hata sözleşmesi | `PROJECT_BRAIN` §12.4–§12.5. G3 → TODOS T16. Tablolar yalnız burada |
| PLAN §4 tehdit modeli (S1–S12) ve rol matrisi | `docs/SECURITY_MODEL.md` (aktif hali, S13–S17 eklendi); `PROJECT_BRAIN` §2, §9. Matrisin kendisi kodda (`shared/roles.ts`). İlk olasılık/etki puanları yalnız burada |
| PLAN §5 uç durumlar, §6 test planı, §7 performans | DAT-11; `PROJECT_BRAIN` §12.8; `CLAUDE.md` doğrulama standardı. p99 hedefleri ve test piramidi yalnız burada |
| PLAN §8 izlenebilirlik | `PROJECT_BRAIN` §10, §12.7; OPS-09. Yazılmamış metrik ve alarmlar (mobil, 5xx) → TODOS T129 ve mobil maddeleri |
| PLAN §10 uzun vade, Faz 2/3 | TODOS → Product/Future "Yön" |
| PLAN §11 tasarım | `PROJECT_BRAIN` §13. "Grafik yok" kuralı eskidi; 56 px → `DECISIONS` UX-04 (Open) |
| PLAN kapsam kararları E1–E10 | `PROJECT_BRAIN` §14. Ertelenenler TODOS T155–T158; E3/E4/E10 → T29/T30/T32 |
| PLAN "MEVCUT DURUM", "HAYAL DURUMU FARKI", "HATA MODU KAYDI", "GSTACK REVIEW REPORT" | Yalnız burada. Güncel durumun yerine `CURRENT_STATE.md` |
| PLAN T1–T119 | Kapalılar burada. Açıklar aynı numarayla TODOS'ta; T92'nin kalanı T90'ın içinde |
| PLAN çözülmemiş kararlar U1–U4 | `DECISIONS` DAT-08 (U1), DAT-15 (U2), OPS-01 (U3), PRD-11 (U4) |
| PLAN eng review D4–D9 | D4 → `PROJECT_BRAIN` §12.10; D5 → SEC-01; D6 → ARC-13; D7 → `PROJECT_BRAIN` §6; D8 → TODOS T48; D9 → ARC-10 |
| PLAN Faz 9 (TD1–TD6) | `PROJECT_BRAIN` §13; yerleşim ayrıntısı kodda (`shell.tsx`, `panel-nav.tsx`) ve `design/`; kiracı değiştirici yokluğu → SEC-14 notu |
| PLAN Faz 10 (fiyat defteri) | `PROJECT_BRAIN` §7; `DECISIONS` PRC-03/05/08/11; `docs/designs/fiyat-defteri.md`; `SECURITY_MODEL` S7, S13; TODOS T90, T91 |
| PLAN Faz 11 (CI incelemesi) | Bulguların hepsi kapalı. Biome, kapsam eşiği, audit ve SHA sabitleme gerekçeleri `ci.yml`, `dependabot.yml` ve `biome.json` yanında |
| PLAN "T42 üretime hazırlık denetimi" | Runbook; TODOS T42, T124, T129 |
| Eski `TODOS.md` (E2, E5, E8, E9, katalog senkronu, Maestro, paketleme) | TODOS T155–T161 (kısa) + `TODOS-2026-08.md` (uzun gerekçe) |
| Eski `CLAUDE.md` | Çalıştırma → `README.md`; dil, Windows tuzakları, bitti ölçütü, skill'ler, gstack → yeni `CLAUDE.md`; mimari kurallar → `PROJECT_BRAIN` §11 (INV-1…10); tasarım → `PROJECT_BRAIN` §13 + UX-04; "Nerede kaldık" → `CURRENT_STATE` + TODOS + DECISIONS `Open` |
| Eski `README.md` "Neyi deneyemezsiniz", "üç kural" | `CURRENT_STATE` "Kısmi / bozuk"; `PROJECT_BRAIN` |
| Devralma denetimi bulguları (2026-10-08) | TODOS T120–T154; DECISIONS DAT-16, SEC-14; SECURITY_MODEL S13–S17 |
