# Trendyol Soru Asistanı — Faz 1

Trendyol satıcılarının müşteri sorularını **salt okunur** olarak çeken, veritabanına kaydeden ve
listeleyen SaaS temeli.

> **Kapsam sınırı:** Bu sürüm Trendyol'a **hiçbir yazma işlemi** yapmaz. Cevap gönderme, ürün
> güncelleme, sipariş değiştirme gibi endpoint'ler kod içinde bulunmaz. Tek kullanılan endpoint:
> `GET /integration/qna/sellers/{sellerId}/questions/filter`.

## Teknolojiler

| Katman | Teknoloji |
| --- | --- |
| Uygulama | Next.js 16 (App Router), TypeScript, React 19 |
| Veritabanı | PostgreSQL + Prisma 7 (`@prisma/adapter-pg`) |
| Doğrulama | Zod 4 (ortam değişkenleri + API yanıtları) |
| Test | Vitest 5 (gömülü PostgreSQL ile gerçek veritabanı testleri) |

## Veri modeli

- **Store** — Trendyol satıcısı (`sellerId` benzersiz).
- **Question** — müşteri sorusu. Kimlik `@@unique([storeId, trendyolQuestionId])` ile mağaza
  bazında benzersizdir; aynı soru tekrar çekildiğinde **upsert** ile güncellenir, kopya oluşmaz.
- **SyncRun** — her senkronizasyon denemesinin kaydı: durum (`RUNNING/SUCCESS/PARTIAL/FAILED`),
  başlangıç/bitiş, süre, çekilen/kaydedilen kayıt ve sayfa sayısı, hata kodu.

Tablolar `prisma/migrations/` altındaki migration ile oluşturulur.

## Kurulum

```bash
npm install                 # bağımlılıklar + prisma generate (postinstall)
cp .env.example .env        # değerleri doldurun
```

### 1. Veritabanı

İki seçenek var.

**A) Gömülü PostgreSQL (önerilen, Docker/kurulum gerekmez)**

```bash
npm run pg:dev
# Çıktıdaki DATABASE_URL değerini .env içine yazın:
# postgresql://postgres:postgres@127.0.0.1:55432/trendyol_dev?schema=public
```

**B) Mevcut PostgreSQL sunucusu** — `.env` içindeki `DATABASE_URL` değerini kendi sunucunuza
yönlendirin.

### 2. Migration

```bash
npm run db:migrate      # geliştirme: migration oluşturur/uygular
# veya
npm run db:deploy       # var olan migration'ları uygular (CI/prod)
```

### 3. Ortam değişkenleri

`.env.example` dosyasını kopyalayıp doldurun. Doğrulama Zod ile yapılır; eksik ya da hatalı değer
varsa uygulama **alan adı ile** birlikte hata verir, hiçbir gizli değer ekrana/loga yazılmaz.

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL bağlantı adresi |
| `TRENDYOL_SELLER_ID` | ✅ | Satıcı kimliği (sadece rakam) |
| `TRENDYOL_API_KEY` | ✅ | Trendyol API anahtarı |
| `TRENDYOL_API_SECRET` | ✅ | Trendyol API gizli anahtarı |
| `TRENDYOL_BASE_URL` | — | Varsayılan `https://apigw.trendyol.com/integration/qna` |
| `TRENDYOL_USER_AGENT` | — | Varsayılan `{sellerId} - SelfIntegration` |
| `SYNC_PAGE_SIZE` | — | Varsayılan `50` |
| `SYNC_MAX_PAGES` | — | Varsayılan `100` |
| `SYNC_MAX_RETRIES` | — | Varsayılan `3` |
| `SYNC_RETRY_BASE_MS` | — | Varsayılan `500` (üstel geri çekilme tabanı) |
| `TRENDYOL_TIMEOUT_MS` | — | Varsayılan `15000` |
| `APP_ACCESS_TOKEN` | Prod'ta ✅ | Paylaşılan erişim anahtarı (en az 16 karakter) |

> **Erişim kapısı:** `APP_ACCESS_TOKEN` tanımlıysa `/api/questions`, `/api/sync` ve `/questions`
> Bearer başlığı ya da `ty_access` çerezi ister. Tanımlı değilse **geliştirmede erişim açıktır**,
> **üretimde (`NODE_ENV=production`) erişim tamamen kapanır (503, fail-closed)** — anahtarsız üretim
> dağıtımı mümkün değildir. Çok kullanıcılı kimlik doğrulama bu fazın kapsamı dışındadır; ayrıntılı
> mimari öneri README sonundaki "Güvenlik" bölümündedir.

## Çalıştırma

```bash
npm run dev        # http://localhost:3000
```

- `/questions` — son 50 soru (soru metni, ürün adı, tarih, Trendyol durumu)
- `/api/health` — uygulama + veritabanı durumu
- `/api/questions` — sayfalı JSON liste (`?status=&page=&limit=`)
- `POST /api/sync` — Trendyol'dan soruları çeker (salt okunur)

```bash
curl -X POST http://localhost:3000/api/sync
curl "http://localhost:3000/api/questions?status=WAITING_FOR_ANSWER&limit=10"
```

### Gerçek API anahtarı olmadan deneme

Yerleşik sahte sunucu, Trendyol yanıt biçimini taklit eder (yalnızca GET):

```bash
npm run mock:trendyol                     # http://127.0.0.1:5599
TRENDYOL_BASE_URL=http://127.0.0.1:5599/integration/qna npm run dev
curl -X POST http://localhost:3000/api/sync
```

## Trendyol istemcisi

`src/lib/trendyol/client.ts`

- **Basic Auth**: `Authorization: Basic base64(apiKey:apiSecret)` — değer hiçbir yerde loglanmaz.
- **User-Agent**: `{sellerId} - SelfIntegration` (Trendyol dokümantasyonu).
- İlk sorgu: `status=WAITING_FOR_ANSWER`, `page=0`, `size=50`, `orderByField=CreatedDate`,
  `orderByDirection=ASC`.
- Hata sınıflandırması ve tekrar politikası:

| Durum | Davranış |
| --- | --- |
| `401` | Tekrar denenmez, `auth` hatası |
| `403` | Tekrar denenmez, yetki hatası |
| `429` | `Retry-After` başlığına (yoksa varsayılan bekleme) uyarak tekrar dener |
| `5xx` | Üstel geri çekilme ile en fazla `SYNC_MAX_RETRIES` kez tekrar |
| Zaman aşımı / ağ | Aynı şekilde sınırlı tekrar, sonra `TIMEOUT`/`NETWORK` kodu |
| `400/404` vb. | Tekrar denenmez |

## Sayfalama ve upsert

`src/lib/trendyol/sync.ts`

- Sayfalar `page=0`'dan başlar; `last=true`, boş sayfa, kısa sayfa veya `totalPages` sınırında durur.
- Güvenlik sınırı: `SYNC_MAX_PAGES`.
- **Sayfa sınırı nedeniyle erken durulursa senkronizasyon `SUCCESS` sayılmaz:** `status: "PARTIAL"`,
  `complete: false`, `stopReason: "PAGE_LIMIT"` ve `incompleteReason` döner; `SyncRun` kaydına da
  `errorCode: "PAGE_LIMIT"` yazılır. Son sayfaya gerçekten ulaşıldığında davranış `SUCCESS`
  (`complete: true`, `stopReason: "COMPLETED"`) olarak korunur.
- `status` filtresi yalnızca desteklenen Trendyol durumlarıyla sınırlıdır:
  `WAITING_FOR_ANSWER`, `ANSWERED`, `REJECTED`.
- **Durum mutabakatı:** `statuses` (veya tek `status`) ile birden fazla durum sırayla taranır.
  `/api/sync` gövdesinde `status`/`statuses` verilmezse varsayılan `["WAITING_FOR_ANSWER", "ANSWERED"]`
  olur; böylece daha önce yerelde `WAITING_FOR_ANSWER` kalmış bir soru Trendyol'da cevaplandıysa
  ikinci geçişte `ANSWERED` olarak güncellenir (`answerText`, `answeredAt` dahil).
  Bir durumda sayfa sınırına takılırsa kalan durumlar taranmaz ve sonuç `PARTIAL` olur.
- Tarih filtresi verilirse aralık **en fazla 14 gün** olabilir (`InvalidDateRangeError`).
- Her soru `storeId + trendyolQuestionId` anahtarıyla `upsert` edilir → tekrar çekimde kopya yok.
- Her çalıştırma için `SyncRun` kaydı: başlangıçta `RUNNING`, sonunda `SUCCESS` / `PARTIAL`
  (bazı sayfalar işlendikten sonra hata) / `FAILED`.

## API yanıt doğrulaması

`src/lib/trendyol/schemas.ts`

- Spring Page sarmalayıcısı ve soru nesnesi Zod ile doğrulanır.
- Şemalar **gevşek** (`z.looseObject`): dokümanda listelenen alanlar sıkı doğrulanır, dokümanda
  olmayan ek alanlar `Question.raw` içinde saklanır. **Dokümanda olmayan alan varsayılmaz.**
- Zorunlu alanlar (`id`, `text`) yoksa veya tip uyuşmazsa `TrendyolResponseValidationError`.

> Not: Şemadaki alan adları Trendyol Q&A dokümantasyonuna dayanır. Gerçek API yanıtıyla
> karşılaştırma **gerçek kimlik bilgileriyle** yapılmalıdır; elde olmayan bir yanıt için
> "entegrasyon doğrulandı" iddiası bu projede yer almaz. Alan adı farkı çıkarsa düzeltme noktası
> `trendyolQuestionSchema` ve `normalizeQuestion()` fonksiyonudur.

## Testler

```bash
npm test
```

Vitest, testler için **kendi gömülü PostgreSQL örneğini** (port `55433`, veri dizini `.pgdata/test`)
başlatır ve migration'ları uygular. Kapsam:

- ortam değişkeni doğrulaması ve gizli değer sızdırmama,
- API yanıt şeması, tarih dönüşümleri, durum eşlemesi,
- Basic Auth / User-Agent başlıkları, sorgu parametreleri,
- 401/403/429/5xx/zaman aşımı davranışları ve tekrar sayıları,
- sayfalama bitiş koşulları, `maxPages` sınırı ve **sayfa sınırında PARTIAL/`complete:false`** davranışı,
- `POST /api/sync` gövde doğrulaması: geçersiz JSON → 400, desteklenmeyen `status` → 400,
  tarih aralığı hataları → 400 (senkronizasyon başlatılmadan),
- erişim kapısı: anahtarsız/yanlış anahtar 401, üretimde anahtarsız 503, doğru anahtar kabul,
- upsert ile kopya oluşmaması, güncelleme tazeliği,
- `SyncRun` başarı/`PARTIAL`/`FAILED` kayıtları,
- HTTP katmanından veritabanına uçtan uca akış,
- **AI taslak katmanı**: prompt'un uydurmayı yasaklaması, ürün bilgisi yokken `VERİLMEDİ` işareti,
  guardrail'in ölçü/garanti/kargo iddialarını yakalaması, sağlayıcı fabrikası (`disabled` → hata,
  anahtarsız `openai-compatible` → hata), sahte `fetch` ile istek gövdesi/başlığı ve güvenli hata mesajları,
- **ürün bilgi kartı**: oluşturma/doğrulama, düzenlemenin doğrulamayı sıfırlaması, değişiklik geçmişi,
  eşleştirme (varyant/ana ürün/belirsiz/eksik) ve mağaza izolasyonu,
- **taslak yaşam döngüsü**: revizyon artışı, eski revizyonun `SUPERSEDED` kalması, onaylayan+zaman kaydı,
  reddetme, uyarı kabulü olmadan onayın engellenmesi, sağlayıcı hatasında hiç kayıt oluşmaması,
  onay sırasında **hiçbir HTTP isteği atılmaması** (`fetch` casusu).

## AI taslak ve insan onayı

`src/lib/llm/` (sağlayıcı bağımsız) + `src/lib/drafts/service.ts` (iş kuralları) + `src/app/drafts/` (panel).

### Yapılandırma (yalnızca ortam değişkenleri)

| Değişken | Açıklama |
| --- | --- |
| `LLM_PROVIDER` | `disabled` (varsayılan) · `mock` · `openai-compatible` |
| `LLM_BASE_URL` | OpenAI uyumlu API kökü (ör. `https://api.openai.com/v1`) |
| `LLM_API_KEY` | **Yalnızca `.env` içinde**; koda/loga/DB'ye yazılmaz |
| `LLM_MODEL` | Model adı (ör. `gpt-4o-mini`) |
| `LLM_TIMEOUT_MS` / `LLM_MAX_TOKENS` / `LLM_TEMPERATURE` | İstek sınırları |
| `LLM_PROMPT_VERSION` | Taslakla birlikte saklanan prompt sürümü |
| `ADMIN_ACTOR_NAME` | Onaylayan/reddeden kişi adı (tek kiracılı kurulum) |

`LLM_PROVIDER=disabled` iken AI taslak düğmesi pasiftir ve panel nedeni açıkça yazar.
Anahtar hiçbir hata mesajına eklenmez; sağlayıcı hata gövdesi okunmaz/yansıtılmaz.

### Uydurma engeli (madde 4)

1. **Prompt**: ürün bilgisi verilmediyse `Ek ürün bilgisi: VERİLMEDİ` işareti ve "somut özellik/ölçü/
   garanti/kargo yazma" talimatı gönderilir.
2. **Guardrail**: üretilen metinde ölçü/garanti/kargo/kumaş/stok iddiası varsa ve doğrulanmış bilgide
   karşılığı yoksa `AnswerDraft.warnings` alanına yazılır ve panelde gösterilir.
3. **Onay kilidi**: uyarı varken onay, "Uyarıları kabul ediyorum" işaretlenmeden **yapılamaz**
   (`DraftWarningsUnacknowledgedError`); kabul edilirse bu durum `reviewNote` ve denetim kaydına yazılır.

### Panel işlemleri (`/drafts`, oturum zorunlu)

- **AI Taslak Oluştur** — isteğe bağlı "doğrulanmış ürün bilgisi" alanıyla
- **Düzenle** — yeni revizyon açar, eski revizyon `SUPERSEDED` olarak **korunur**
- **Onayla** — durum `APPROVED`, `approvedBy`, `approvedAt` yazılır
- **Reddet** — durum `REJECTED`, `rejectedBy`, `rejectedAt` yazılır
- Her işlem `draft_events` tablosuna (kim, ne zaman, ne yaptı) kaydedilir.

> **Trendyol'a hiçbir şey gönderilmez.** Onay yalnızca veritabanındaki taslağın durumunu değiştirir;
> projede cevap gönderme endpoint'i yoktur ve eklenmemiştir.

### Veri modeli

`AnswerDraft` (revizyon + durum + metin + uyarılar + onay/red bilgileri) ve `DraftEvent` (denetim
kaydı) tabloları **yalnızca eklenir**; mevcut `Store` / `Question` / `SyncRun` şeması değişmez.
Migration: `npx prisma migrate deploy` (`20261110003430_answer_drafts`).

## Ürün bilgi kartları ve eşleştirme

`src/lib/products/matching.ts` (eşleştirme) + `src/lib/products/service.ts` (kayıt/doğrulama) +
`src/app/products/` (panel).

### Veri modeli

- **ProductInfo** — `storeId` + `productMainId` (zorunlu) + `productId` (varyant, opsiyonel),
  `title`, `attributes` (`[{label,value}]`), `notes`, `status` (`DRAFT`/`VERIFIED`),
  `verifiedBy`, `verifiedAt`, `createdBy`
- **ProductInfoEvent** — her işlem için `CREATED`/`UPDATED`/`VERIFIED`/`UNVERIFIED` + `changes`
  (önceki ve sonraki değerler) → değişiklik geçmişi
- `AnswerDraft`'a eklenen iz alanları: `productInfoId`, `productMatch`, `usedFacts`, `missingInfo`

### Eşleştirme kuralları (varyant karışıklığına karşı)

| Durum | Sonuç |
| --- | --- |
| Aynı mağaza + `productMainId` + `productId` | `EXACT_VARIANT` — kullanılır |
| Aynı mağaza + `productMainId`, kayıt ana ürün düzeyinde | `MAIN_PRODUCT` — kullanılır |
| Soruda varyant kimliği yok, ana ürün altında birden fazla varyant kaydı var | `AMBIGUOUS` — **bilgi kullanılmaz** |
| Eşleşen kayıt yok / farklı mağaza | `MISSING` — bilgi kullanılmaz |

- Yalnızca `VERIFIED` kartlar AI girdisi olur; `DRAFT` kart "doğrulanmamış" olarak raporlanır.
- Başka mağazanın kaydı hiçbir koşulda kullanılmaz.

### Panel (`/products`, oturum zorunlu)

- Kart oluşturma (özellikler `Etiket: Değer` satırlarıyla), düzenleme, **doğrulama**, doğrulamayı kaldırma
- Ürün kimliği / varyant kimliği / başlıkta arama, durum filtresi (`DRAFT` / `VERIFIED`)
- Her kartta değişiklik geçmişi (kim, ne zaman, ne değişti)
- Düzenleme doğrulanmış kartı yeniden `DRAFT` yapar → doğrulama her zaman güncel içerik için geçerlidir

### AI entegrasyonu

- `createAiDraft` önce eşleştirme yapar; doğrulanmış özellikler prompt'a `Etiket: Değer` olarak girer.
- Guardrail'in "bilinen bilgi" listesi bu özelliklerle beslenir → doğrulanmış ölçü/özellik uyarı üretmez,
  kart dışı iddia üretir.
- Taslakta `usedFacts` (kullanılan bilgi + kaynağı: `VERIFIED_CARD` / `MANUAL`), `missingInfo`
  (eksik/doğrulanmamış bilgiler) ve `productMatch` saklanır; `/drafts` panelinde gösterilir.

> Ürün bilgi kartı da Trendyol'a hiçbir şey göndermez; yalnızca yerel bilgi tabanıdır.

## Proje yapısı

```
prisma/
  schema.prisma            Store / Question / SyncRun
  migrations/              SQL migration'lar
prisma7.config.ts          Prisma CLI konfigürasyonu (DATABASE_URL)
src/
  app/
    questions/page.tsx     Soru listesi ekranı
    drafts/page.tsx        Taslak paneli (AI oluştur / düzenle / onayla / reddet)
    drafts/actions.ts      Sunucu eylemleri (oturum kapısı + servis çağrıları)
    products/page.tsx      Ürün bilgi kartları (oluştur / düzenle / doğrula / ara)
    products/actions.ts    Ürün kartı sunucu eylemleri
    api/health/route.ts    Sağlık kontrolü
    api/questions/route.ts Sayfalı JSON liste
    api/sync/route.ts      Senkronizasyon tetikleyici (POST)
  lib/
    env.ts                 Zod ile ortam doğrulaması
    logger.ts              Gizli bilgi maskeleyen logger
    prisma.ts              Prisma istemcisi (driver adapter)
    llm/types.ts           Sağlayıcı arayüzü ve hata tipleri
    llm/prompt.ts          Uydurmayı yasaklayan prompt kuralları
    llm/guardrails.ts      Doğrulanmamış iddia tespiti + metin normalizasyonu
    llm/provider.ts        mock / openai-compatible sağlayıcı fabrikası
    drafts/service.ts      Taslak yaşam döngüsü + denetim kaydı (Trendyol'a yazma YOK)
    products/matching.ts   Mağaza + ürün kimliğiyle güvenli eşleştirme (varyant koruması)
    products/service.ts    Ürün bilgi kartı CRUD, doğrulama, değişiklik geçmişi
    trendyol/client.ts     HTTP istemcisi + tekrar politikası
    trendyol/schemas.ts    API yanıt şemaları + normalize
    trendyol/sync.ts       Sayfalama, upsert, SyncRun
scripts/
  dev-postgres.ts          Gömülü PostgreSQL (geliştirme)
  mock-trendyol.ts         Sahte Trendyol API'si (geliştirme)
  live-check.ts            Gerçek API'ye tek salt okunur istek + şema doğrulaması (npm run live:check)
tests/                     Vitest testleri + global setup
```

## Güvenlik

- `.env` Git'e eklenmez (`.gitignore`).
- API anahtarları, Basic Auth başlığı, müşteri verisi loglanmaz; logger hassas anahtarları,
  `Basic ...`/`Bearer ...` kalıplarını ve **bağlantı adreslerini** (`postgresql://…`) maskeler.
- Bilinmeyen iç hataların (Prisma/pg dahil) mesajı dışarıya **verilmez**: `describeError()` sabit bir
  metin + `INTERNAL_ERROR` kodu döndürür, ayrıntı yalnızca sunucu loguna yazılır. Böylece veritabanı
  bağlantı adresi (parola) veya müşteri verisi API yanıtına / `SyncRun` kaydına sızmaz.
- Üretim API'sine sadece soru **okuma** isteği gider.

### Erişim kontrolü (Faz 1.2)

| Uç nokta | Koruma |
| --- | --- |
| `/api/health` | Açık (müşteri verisi yok, yalnızca durum) |
| `/api/questions`, `/api/sync` | `APP_ACCESS_TOKEN` (Bearer veya `ty_access` çerezi) |
| `/questions` | Aynı anahtar; form ile httpOnly çerez verilir, "Oturumu kapat" çerezi siler |

- Anahtar karşılaştırması `crypto.timingSafeEqual` ile sabit zamanlıdır.
- Anahtar sorgu parametresiyle **kabul edilmez** (URL'ler loglara düşer).
- Üretimde anahtar yoksa istekler `503` ile reddedilir; geliştirmede açık bırakılır.

### Çok kullanıcılı kimlik doğrulama — mimari karar ve plan (yapılmadı)

Bu fazda bilinçli olarak kullanıcı tablosu/oturum yönetimi **eklenmedi**; paylaşılan tek anahtar,
tek satıcılı bir kurulumda müşteri verisini korumak için yeterlidir. Gerçek SaaS'a geçerken önerilen
sıra:

1. **Kimlik sağlayıcı**: Auth.js (NextAuth) v5 + Credentials yerine e-posta/parola için `argon2`
   hash'li `User` modeli, ya da kurumsal müşteri için OIDC/SAML sağlayıcısı.
2. **Veri modeli**: `User`, `Membership(userId, storeId, role)` — her `Question`/`SyncRun` zaten
   `storeId` taşıdığı için çok kiracılı ayrım sorgu katmanında `storeId IN (...)` ile uygulanır.
3. **Yetkilendirme**: tüm API rotaları `requireStoreAccess(request, storeId)` yardımcısından geçer;
   varsayılan reddet (allow-list). `role`: `owner` / `viewer`.
4. **Oturum**: httpOnly + `Secure` + `SameSite=Lax` çerez, rotasyonlu oturum kimliği, CSRF token'ı
   mutasyon uç noktalarında.
5. **Denetim**: `AuditLog(userId, action, storeId, createdAt)` — soru metni/kimlik bilgisi kaydedilmez.
6. **Geçiş**: paylaşılan anahtar kaldırılmadan önce iki mod birlikte çalıştırılır (feature flag),
   ardından anahtar devre dışı bırakılır; mevcut tek satıcı ilk `owner` olarak taşınır.

O zamana kadar: `APP_ACCESS_TOKEN` üretimde zorunludur, paneli yalnızca sunucu içinden erişilebilir
bir ağ/VPN arkasında tutmak ek savunma katmanı olarak önerilir.

## Bilinen sınırlar (Faz 1)

- Cevap gönderme, ürün/sipariş işlemleri yok (bilinçli).
- Kimlik doğrulama/çoklu kullanıcı yok; tek satıcı `.env` üzerinden yapılandırılır.
- Zamanlanmış senkronizasyon yok; `POST /api/sync` ile manuel tetiklenir.

## Gerçek LLM, maliyet ölçümü ve kalite değerlendirme (GÖREV 005)

### Sağlayıcı yapılandırması

| Değişken | Açıklama |
| --- | --- |
| `LLM_PROVIDER` | `disabled` (varsayılan) / `mock` / `openai-compatible` |
| `LLM_BASE_URL` | OpenAI uyumlu kök adres (`.../v1`); kod `/chat/completions` ekler |
| `LLM_API_KEY` | Yalnızca `.env`'de tutulur; log/DB/hata mesajına yazılmaz |
| `LLM_MODEL` | Ör. `gpt-4o-mini` |
| `LLM_MAX_RETRIES` / `LLM_RETRY_BASE_MS` | 429/5xx/ağ hatasında tekrar sayısı ve bekleme |
| `LLM_INPUT_COST_PER_1K` / `LLM_OUTPUT_COST_PER_1K` | 1K token başına USD. **Sabit fiyat varsayılmaz**; tanımlanmazsa maliyet 0 raporlanır |

Hata yönetimi: `429/5xx/ağ` → sınırlı tekrar (`Retry-After`'a uyulur), `400/401/403/404` → tekrar yok,
bozuk JSON → `INVALID_JSON`, zaman aşımı → `TIMEOUT`, boş yanıt → `EMPTY_RESPONSE`. Sağlayıcı hata gövdesi
okunmaz; anahtar hiçbir koşulda mesaja/loga/veritabanına yazılmaz.

### Güvenli cevap üretimi

- Müşteri metni **güvenilmez veri** olarak işaretlenir (`<<<SORU_BASLANGIC>>>` sınırları), injection kalıpları
  etkisizleştirilir, telefon/e‑posta/IBAN/sipariş no maskelenir (`src/lib/llm/sanitize.ts`).
- Guardrail'e `PROMISE` türü eklendi: "kesinlikle göstermez", "tam karartma sağlar", "yarın teslim",
  "iade garantisi" gibi doğrulanmamış vaatler yakalanır.
- Doğrulanmış bilgi **yokken** kesin vaat içeren taslak `NEEDS_INFO` durumunda açılır ve onaylanamaz;
  insan düzenleyip yeni revizyon açana kadar onay yolu kapalıdır. Diğer uyarılar mevcut
  `acknowledgeWarnings` akışıyla onaylanabilir.
- Elle girilen bilgi doğrulanmış ürün kartı statüsü **kazanmaz** (`ProductInfo.status` yalnızca yönetici
  doğrulamasıyla `VERIFIED` olur, kullanım kaynağı taslakta `MANUAL` olarak görünür).

### Token ve maliyet kaydı

Her çağrı `llm_usages` tablosuna yazılır: `provider, model, promptVersion, outcome (SUCCESS/ERROR), errorCode,
durationMs, inputTokens, outputTokens, totalTokens, estimated, estimatedCostUSD, draftId, questionId, purpose, createdAt`.
Sağlayıcı `usage` vermezse token tahmin edilir ve `estimated = true` işaretlenir. Başarısız çağrılar da kaydedilir.
Taslak ekranında model, süre, token ve tahmini maliyet gösterilir; `/quality` günlük ve toplam rapor verir.

### Kalite sistemi (`/quality`)

- Yalnızca yönetici oturumuyla erişilir.
- 30–50 örnekli set, gerçek sorulardan **seçilerek** oluşturulur; sorular sette sabitlenir, böylece aynı set
  farklı prompt sürümleriyle yeniden çalıştırılıp karşılaştırılabilir.
- Otomatik kontroller: uyarı sayısı, doğrulanmış bilgi var/yok, cümle sayısı, karakter uzunluğu, selamlama/emoji,
  `needsHuman` önerisi. Bunlar insan değerlendirmesinin **yerine geçmez**; 1–5 puan ve not insan tarafından girilir.
- Saklanan soru metni PII maskelenmiştir; Trendyol'a istek gitmez, cevap yazılmaz.
- Panelde test edilen soru sayısı, ortalama insan puanı, uyarı oranı, bilgi eksikliği oranı, tahmini toplam maliyet
  ve günlük kullanım tablosu bulunur.

### Veritabanı bütünlüğü

`product_infos_main_unique` kısmi (partial) benzersiz indeksi: aynı mağaza + `productMainId` için `productId IS NULL`
olan **tek** kayıt. Migration öncesinde mükerrer kontrol yapar; mükerrer varsa **silmez/birleştirmez**, açık hata
mesajıyla durur. Ana ürün kartına varyantlar arasında farklılaşan özellik yazılamaz (`MAIN_CARD_CONFLICT`).

### Test kapsamı

`npm test` → 12 dosya / **184 test** (GÖREV 004'ün 149 testi korunuyor). Yeni testler: sağlayıcı 429/5xx/timeout/
bozuk JSON/boş yanıt, usage ayrıştırma ve maliyet, PII maskeleme, prompt injection, vaat tespiti, `NEEDS_INFO`,
kullanım/başarısız çağrı kaydı, kalite koşusu ve puanlama, yetkisiz erişim, tekrar çalıştırma, NULL `productId`
benzersizlik ve ana ürün kartı çakışması.

## OpenAI canlı bağlantı ve canlı kalite testi (GÖREV 006)

### Yapılandırma

`.env` (asla commit edilmez):

```
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...            # yalnızca .env
LLM_MODEL=gpt-4o-mini
LLM_MAX_TOKENS=400
LLM_TEMPERATURE=0.2
LLM_STORE=false            # istek sağlayıcıda saklanmaz
LLM_INPUT_COST_PER_1K=...  # gerçek fiyat tarifeniz
LLM_OUTPUT_COST_PER_1K=...
LLM_MAX_COST_USD=2         # toplu test bütçe üst sınırı
LLM_SMOKE_MAX_COST_USD=0.05
```

URL normalizasyonu: sonda `/chat/completions` varsa kaldırılır, tekrarlanmış `/v1/v1` düzeltilir —
uç nokta hiçbir zaman `/v1/v1/chat/completions` olmaz. Model uyumluluğu: `o*`/`gpt-5*` muhakeme modellerinde
`max_completion_tokens` kullanılır ve `temperature` gönderilmez; diğer modellerde `max_tokens` + kırpılmış
`temperature` (0–2).

Yanıt durumları güvenli işlenir: `finish_reason=length` → `TRUNCATED` (taslak kaydedilmez),
`content_filter` → `CONTENT_FILTER`, `message.refusal` dolu → `REFUSAL`, boş içerik → `EMPTY_RESPONSE`.
`usage.prompt_tokens/completion_tokens/total_tokens` gerçek değerleriyle kaydedilir; alan yoksa tahmin + `estimated=true`.

### Komutlar

| Komut | Ne yapar | Ücret |
| --- | --- | --- |
| `npm run llm:smoke` | Tek çağrılık bağlantı testi; plan + tahmini üst maliyet yazdırır, sonucu `llm_usages`'a (`purpose=smoke`) kaydeder | 1 istek |
| `npm run llm:quality -- --onay` | 10 gerçek soruda canlı kalite testi; `--onay` yoksa **çalışmaz** | ≤10 istek, `LLM_MAX_COST_USD` sınırı |

Canlı test korumaları: anahtar yoksa istek atılmaz (exit 3), onay bayrağı yoksa çalışmaz (exit 4),
fiyat tarifesi 0 ise ücretli toplu test başlamaz (exit 5), tahmini maliyet bütçeyi aşarsa başlamaz,
her soru için en fazla bir çağrı (sağlayıcı tekrarı kapalı), bütçe dolunca döngü durur.
Test yalnızca ölçüm yapar: taslak oluşturmaz, onaylamaz, Trendyol'a istek göndermez; soru metinleri PII'den arındırılır.

### İnsan değerlendirmesi

Canlı test çıktısı tek başına "kalite başarılı" anlamına gelmez. Her cevap için doğruluk, ürün bilgisine bağlılık,
Türkçe üslup (1–5), vaat/uydurma, eksik bilgi, insan düzenlemesi ve **KABUL / DÜZENLE / REDDET** kararı insan
tarafından verilir. Kalıcı kayıt ve puanlama `/quality` ekranından yapılır.

### OpenAI uyumlu geçitler (ör. OpenCode Go)

`gpt-4o-mini` gibi modeller her geçitte bulunmayabilir; geçidin `/v1/models` listesinden gerçek model adı seçilmelidir.
Bazı geçitler oturum başlığı zorunlu tutar (`MissingSessionID` hatası):

```
LLM_BASE_URL=https://opencode.ai/zen/go/v1
LLM_MODEL=gpt-5.6-luna
LLM_SESSION_HEADER=x-opencode-session
# LLM_SESSION_ID boş bırakılırsa çalışma başına rastgele üretilir
LLM_INPUT_COST_PER_1K=0.0002    # 0,20 USD / 1M girdi
LLM_OUTPUT_COST_PER_1K=0.0012   # 1,20 USD / 1M çıktı
```

Fiyat, geçidin `/v1/models` yanıtındaki `cost` alanından okunup 1K token'a çevrilir; sabit varsayım yapılmaz.

## Sipariş durumuna göre ölçü değişikliği (GÖREV 007)

Sipariş **salt okunur** aynalanır ve müşterinin ölçü değişikliği talebi yalnızca sipariş uygun durumdayken
kaydedilir. Trendyol'a hiçbir sipariş güncellemesi veya müşteri cevabı gönderilmez.

### Sipariş API'si

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `ORDERS_BASE_URL` | `https://apigw.trendyol.com/integration/order` | Sipariş servis kökü (`/sellers/{sellerId}/orders` eklenir) |

`src/lib/trendyol/orders-client.ts` yalnızca `GET` kullanır: sayfalı liste ve `nextCursor` tabanlı akış
(`/orders/stream`). Saklanan alanlar: sipariş numarası, paket kimliği, kalem kimliği, ürün kimlikleri, adet, durum.
Adres, telefon, e-posta, kimlik ve ödeme bilgisi **kaydedilmez**; müşteri kimliği yalnızca tuzlanmış `sha256` özeti
(`customerRef`) olarak tutulur.

### Karar motoru

| Sipariş durumu | Karar |
| --- | --- |
| `Created` | Talep alınabilir |
| `Picking`, `Invoiced`, `Shipped`, `Delivered` | Talep reddedilir |
| `Cancelled`, `Returned`, `Awaiting`, `UnPacked`, bilinmeyen | İnsan incelemesi |

Karar tek başına yeterli değildir: talep **PENDING_REVIEW** olabilmesi için müşteri sahipliğinin API verisiyle
doğrulanması, sipariş kaleminin tek anlamlı eşleşmesi ve en/boy yönünün metinden kesin çıkması gerekir.
Bunlardan biri eksikse talep `NEEDS_VERIFICATION` olur. Sipariş numarası bilmek yetki kanıtı sayılmaz.

### Veri modeli

`Order` / `OrderLine` (ayna), `OrderChangeRequest` (talep) ve `OrderChangeEvent` (denetim kaydı).
Durumlar: `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `NEEDS_VERIFICATION`, `INVALIDATED`.
Kısmi tekil indeks (`20261110020800_order_change_active_unique`), aynı soru + sipariş kalemi için ikinci **aktif**
talebi veritabanı düzeyinde engeller; geçmiş kayıtlar korunur.

### Onay akışı ve eşzamanlılık

1. Onaydan önce sipariş durumu **canlı** yeniden sorgulanır.
2. Durum hâlâ `Created` değilse onay yapılmaz, talep `INVALIDATED` olur (`ORDER_STATUS_CHANGED`).
3. Durum koşullu güncelleme (`updateMany ... where status`) ile tek seferde değişir; çift tıklama/yarış
   durumunda ikinci istek `ALREADY_APPROVED` alır.
4. API'ye ulaşılamazsa ne talep oluşturulur ne onay verilir (`ORDERS_API_UNAVAILABLE`).
5. `Created` olması ölçü değişikliğinin uygulandığı anlamına gelmez; onay yalnızca üretim personelinin kararıdır.

### Paneller

- `/orders` — sipariş numarasıyla arama, canlı Trendyol durumu, karar, kalemler, yerel ayna, talepler.
- `/change-requests` — filtreli talep listesi, onay/ret, **üretim için onaylı ölçü değişiklikleri** listesi
  (`?print=1` yazdırma görünümü), denetim izi.

> **Yetki sınırı:** Paylaşılan yönetici anahtarı gerçek kullanıcı kimliği değildir; onaylayan aktör güvenilir
> biçimde izlenemez. Çok kullanıcılı kullanımdan önce kullanıcı bazlı kimlik doğrulama gerekir.

### AI kısıtları

Talep durumuna göre izin verilen ifadeler değişir (`src/lib/orders/ai-guidance.ts`):

| Durum | İzin verilen |
| --- | --- |
| Talep yok | Yalnızca "talebinizi değerlendireceğiz" |
| `PENDING_REVIEW` | "Talebinizi aldık, üretim onayı bekleniyor" |
| `APPROVED` | "Talebiniz onaylandı" |
| Sipariş `Picking`+ | "İşleme alındığı için değişiklik yapılamıyor" |

Onaylı kayıt yokken "onaylandı / uygulanacak / yapılamıyor" gibi kesin ifadeler uyarı üretir ve taslak
`NEEDS_INFO` durumuna düşer; onaylanabilir sahte cevap kaydedilmez. AI kendi başına talep onaylayamaz.

### Komutlar

| Komut | Ne yapar |
| --- | --- |
| `npm run mock:orders` | Mock sipariş servisi (port 5597, `POST /_control` ile durum değiştirilebilir) |
| `npx tsx scripts/e2e-orders.mts` | Gerçek PostgreSQL + mock servis E2E (oluştur/onayla/geçersiz kıl/kesinti) |
| `npx tsx scripts/live-orders-check.mts` | Gerçek Trendyol'a **tek** salt okunur `GET`, PII yazdırmaz |

## Geçmiş cevap hafızası (GÖREV 008)

Trendyol'da daha önce verilmiş **satıcı cevapları** aynı salt okunur senkronizasyonla `questions` tablosunda
tutulur (`answerText`, `answeredAt`); `(storeId, trendyolQuestionId)` benzersiz olduğu için tekrar kayıt oluşmaz.
Yeni soru üretilirken aynı mağazadaki benzer geçmiş cevaplar AI'ya **referans** olarak verilir.

### Arama (Türkçe)

`pg_trgm` uzantısı + GIN indeksleri (`questions.text`, `questions.answerText`) kullanılır. Trigram Türkçe ekleri
kökemediği için sıralama üç sinyalle birleştirilir:

1. aynı ürün (`productMainId`) → +0.25,
2. trigram benzerliği (`similarity`),
3. anahtar kelime örtüşmesi (kaba ek kırpma, stopword temizliği) → +0.35 × oran,
4. `VERIFIED` cevap → +0.10.

En iyi 4 kayıt (en fazla 10) bağlama girer; `WRONG` ve `OUTDATED` kayıtlar **hiç girmez**, `UNREVIEWED` girebilir.
Embedding altyapısı opsiyoneldir: `src/lib/history/search.ts` içindeki sıralama vektör skoruyla değiştirilebilir,
arayüz (`searchHistoricalAnswers`) aynı kalır.

### Doğrulama durumları (`/answers`)

| Durum | Anlamı | AI bağlamı |
| --- | --- | --- |
| `UNREVIEWED` | Senkronize edildi, insan bakmadı | Girebilir (referans) |
| `VERIFIED` | İnsan doğruladı | Girebilir (yine kanıt değil) |
| `WRONG` | Hatalı | **Girmez** |
| `OUTDATED` | Güncelliğini yitirdi | **Girmez** |

Panelde durum + not + doğrulayan + zaman kaydedilir. Otomatik hiçbir süreç bu durumu kendiliğinden değiştirmez.

### Güncelliğini yitirmiş bilgi koruması

`src/lib/history/guard.ts` fiyat, stok, teslimat, iade ve sipariş değişikliği iddialarını tespit eder. Geçmiş cevap
kullanıldıysa ve doğrulanmış ürün kartı/canlı sipariş doğrulaması yoksa taslak `NEEDS_INFO` olur (`STALE` uyarısı).
Doğrulanmış kart varsa uyarı üretilir ama onay akışı engellenmez.

### Taslak ekranı

`/drafts` kartında **Yararlanılan geçmiş cevaplar** bloğu görünür: Trendyol soru kimliği, doğrulama durumu,
benzerlik skoru ve eşleşme gerekçesi (örn. "aynı ürün · kelime örtüşmesi %50"). Bu bilgiler `answer_drafts.historyUsed`
alanına da yazılır.

### Sahiplik (GÖREV 007 riski kapatıldı)

Müşteri sahipliği API verisiyle doğrulanmadıysa onay **yalnızca serbest metin notuyla** verilemez:
`OWNERSHIP_NOT_VERIFIED`. Önce `/change-requests` ekranından "Sahipliği doğrula" adımı çalışır ve
`ownershipVerifiedBy/At` + `OWNERSHIP_VERIFIED` olayı yazılır; onay ancak bundan sonra mümkündür.

### Ölçüm

```
npx tsx scripts/sync-answers.mts            # ANSWERED + gerçek satıcı cevaplarını senkronize eder
npx tsx scripts/history-compare.mts --onay  # 10 soruda hafızalı/hafızasız karşılaştırma (20 çağrı)
```

Karşılaştırma puanları **otomatiktir** (uzunluk, genel/kaçamak ifade sayısı, `STALE`/`NEEDS_INFO`), insan
değerlendirmesinin yerine geçmez. Ölçüm taslakları iş bitiminde silinir; gerçek sorular değişmez.

## Ürün bilgi bankası ve toplu doğrulama (GÖREV 009)

### Ürün listesi

`/product-bank` en çok soru gelen **10 ürünü** gösterir: `productMainId`, ürün adı (sorulardan), soru/cevap sayısı,
varyant kimlikleri, kart durumu ve doğrulanmış alan sayısı. Ürün adı veride yoksa **uydurulmaz**.
Trendyol katalog API'si (`GET /integration/product/sellers/{sellerId}/products`) salt okunur olarak kullanılabilir;
bu sürümde adlar soru verisinden gelir. Varyantlar `productId` ile ayrı tutulur, ana ürün altında yanlış birleştirilmez.

### Alan bazında doğrulama

10 alan: kumaş türü, pile oranı, dikim şekli, karartma seviyesi, kurşunlu etek, ütü/yıkama, montaj, özel ölçü,
renkler, açıklama. Her alan kendi `verified`, `verifiedBy`, `verifiedAt`, `source` bilgisini taşır.

- Bir alanı doğrulamak **diğer alanları doğrulamaz** (`verifyField`).
- Değer değişirse doğrulama düşer (`setField` → `verified=false`).
- AI yalnızca `verified=true` alanları "doğrulanmış bilgi" sayar; kart `DRAFT` olsa bile doğrulanmış alan kullanılır,
  `verified=false` alan **hiç kullanılmaz**.
- Toplu düzenleme (`bulkSetField`) ve CSV içe aktarma **doğrulanmamış** yazar; doğrulama ayrı adımdır.

### CSV

`/product-bank/csv` (oturumlu) tüm kartları indirir. İçe aktarma kolonları:
`productMainId, productId, fabric, pleat, sewing, blackout, weightedHem, care, mounting, customSize, colors, description`.
Türkçe karakterler ve tırnaklı alanlar desteklenir; `productMainId` zorunludur.

### Geçmiş cevaplardan öneri

Son 87 soru-cevaptan kural tabanlı adaylar çıkarılır (`src/lib/products/suggestions.ts`): kumaş/pile/ölçü/renk/
yıkama/montaj kategorileri. Fiyat, stok, teslimat, iade ve sipariş cevapları **kalıcı özelliğe dönüştürülmez**.
Her öneri kaynak soru kimliklerini taşır; aynı alanda farklı değerler **çelişki** olarak işaretlenir.
Kabul edilen öneri bile alana **doğrulanmamış** olarak yazılır — doğrulama insan adımıdır.

Gerçek veride üretim: 9 ürün · **21 öneri** · **14 çelişki** (ör. aynı ürün için "özel ölçü yapamıyoruz" ↔
"ölçülerimiz EN × BOY şeklindedir").

### Hafıza kalitesi

Sorular kategoriye ayrılır (`MEASURE, PLEAT, FABRIC, COLOR, WASH, MOUNT, ORDER, RETURN, SHIPPING, OTHER`).
Geçmiş cevap aramasında yalnızca aynı/yakın kategori kullanılır: ölçü sorusuna kargo cevabı girmez.
`UNREVIEWED` cevap doğrulanmış gerçek sayılmaz; güncel doğrulanmış kart her zaman önceliklidir.

### Taslak entegrasyonu

- `usedFacts` yalnızca doğrulanmış alanları taşır (`source: VERIFIED_CARD`); kartta/alanlarda kaynak ve tarih görünür.
- `missingInfo` eksik alanları **alan adıyla** listeler (ör. "Pile oranı"), yalnızca eksik alan için NEEDS_INFO üretilir.
- `resolution`: `RESOLVED` (doğrulanmış bilgiyle, vaat/stale uyarısı yok) · `GENERIC` (bilgi yok) · `NEEDS_INFO`.
- Sipariş değişikliği kuralları (GÖREV 007/008) aynen korunur; canlı durum ve sahiplik doğrulaması değişmedi.

### Erişim kapısı (sıkılaştırıldı)

`APP_ACCESS_TOKEN` boşsa uygulama **her ortamda** 503 döner (geliştirmede açık kapı yok). Anahtar tanımlıysa
Bearer veya `ty_access` çerezi gerekir. Bu değişiklik testlerde de anahtar zorunlu kılar (`vitest.config.ts`).

### Ölçüm (gerçek çıktı)

```
npx tsx scripts/product-quality.mts --onay --phase baseline   # gerçek 10 soru, kart yok
npx tsx scripts/product-quality.mts --onay --synthetic        # SENTETİK A/B mekanizma kanıtı
```

| Ölçüm | RESOLVED | Kaçamak | NEEDS_INFO | Yanlış iddia | Ort. uzunluk |
| --- | --- | --- | --- | --- | --- |
| Gerçek 10 soru, doğrulanmış alan **0** | 0/10 | 9 | 0 | 0 | 98 kr |
| Sentetik A: kart yok | 0/4 | 4 | 0 | 0 | 82 kr |
| Sentetik B: 2 alan doğrulandı | **4/4 (%100)** | 0 | 0 | 0 | 70 kr |

Gerçek veride doğrulanmış alan olmadığı için kalite artışı **iddia edilmiyor**; sentetik A/B yalnızca mekanizmanın
çalıştığını gösterir. Gerçek artış, `/product-bank` ekranından alanlar doğrulandıktan sonra `--phase after` ile ölçülür.
