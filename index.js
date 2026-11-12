import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
} from '@whiskeysockets/baileys'
import P from 'pino'
import fs from 'fs'

// ================= إعدادات =================
const OLLAMA_URL = 'http://localhost:11434/api/chat'
const OLLAMA_MODEL = 'qwen2.5:7b'
const USE_OLLAMA = true
const ALLOW_GROUPS = false
const OWNER_NAME = 'عبدالله'
const OWNER_JID = '201149693244@s.whatsapp.net'
const BOT_NAME = `المساعد الذكي لـ${OWNER_NAME}`
const PAIR_NUMBER = process.env.PAIR_NUMBER || ''
const DATA_FILE = './data.json'
const DEBOUNCE_MS = 1200
const MAX_PER_MIN = 15

const SYSTEM_PROMPT = `انت "${BOT_NAME}"، مساعد ذكي شخصي بيرد على واتساب نيابةً عن ${OWNER_NAME}.
الشخصية: مصري، ذكي، سريع البديهة، محترم ودمه خفيف، عامية مصرية طبيعية.
القواعد:
- افهم قصد الشخص الحقيقي وجاوب مباشرة. ماتكررش كلامه ولا تقول جمل فاضية.
- من سطر لـ٤ سطور بالكتير. ايموجي خفيفة بس.
- لو متأكد جاوب بثقة. لو مش متأكد قول كده بصراحة وماتألفش ابدا.
- لو سأل انت مين: "انا ${BOT_NAME}". انت مساعد ذكي ومش انسان.
- لو عايز ${OWNER_NAME}: قوله مش متاح دلوقتي وانك تقدر توصله رسالة.`

// ================= تخزين =================
let data = { users: {}, learned: [], paused: false }
try { data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } } catch {}
let saveT
const save = () => {
  clearTimeout(saveT)
  saveT = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(data), () => {}), 1000)
}

// ================= تنضيف اللغة =================
const FRANCO = {
  ezayak: 'ازيك', ezayek: 'ازيك', ezayk: 'ازيك', '3amel': 'عامل', eh: 'ايه', ana: 'انا', enta: 'انت',
  shokran: 'شكرا', tamam: 'تمام', salam: 'سلام', ahlan: 'اهلا', hi: 'هاي', hello: 'اهلا',
  mesh: 'مش', msh: 'مش', ayez: 'عايز', '3ayez': 'عايز', bokra: 'بكره', fein: 'فين', leh: 'ليه',
  haha: 'ههه', thanks: 'شكرا', bye: 'باي', ok: 'اوكي', aywa: 'ايوه', la: 'لا', habibi: 'حبيبي',
}
function normalize(s = '') {
  const t = s.toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[^\p{L}\p{N}\s+\-*/().%^×÷]/gu, ' ')
    .replace(/\s+/g, ' ').trim()
  return t.split(' ').map(w => FRANCO[w] || w).join(' ')
}
const squash = s => s.replace(/(.)\1+/g, '$1')
const pick = a => a[Math.floor(Math.random() * a.length)]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const NICK = ['يا غالي', 'يا باشا', 'يا حب', 'يا صاحبي']

// ================= النوايا =================
const intents = [
  { name: 'salam', k: ['السلام عليكم', 'سلام', 'الو', 'هلا', 'اهلا', 'هاي', 'صباح الخير', 'مساء الخير', 'نورت'],
    r: ['يا هلا والله 😂❤️ نورت الدنيا {n}', 'هلا والله بالغالي، عامل ايه {n}؟', 'وعليكم السلام ورحمة الله {n} 😍'], expect: 'mood' },
  { name: 'howareyou', k: ['عامل ايه', 'ازيك', 'اخبارك', 'ايه الاخبار', 'كيفك', 'ايه الدنيا'],
    r: ['زي الفل والله طول ما انت بخير 😎 انت عامل ايه {n}؟', 'الحمدلله زي العسل، قولي انت اخبارك ايه؟'], expect: 'mood' },
  { name: 'thanks', k: ['شكرا', 'تسلم', 'مرسي', 'شكرا ليك'],
    r: ['حبيبي على ايه، احنا اخوات ❤️', 'يا باشا متقولش كده، انت تؤمر'] },
  { name: 'who', k: ['اسمك ايه', 'انت مين', 'مين انت', 'انت بوت', 'انت انسان'],
    r: [`انا ${BOT_NAME} 😎 مساعد ذكي بيرد بدل ${OWNER_NAME} لما ميبقاش متاح.`] },
  { name: 'sad', k: ['زعلان', 'مخنوق', 'متضايق', 'حزين', 'تعبان نفسيا', 'مكتئب', 'زهقان'],
    r: ['معلش {n}، الدنيا بتعدي 🤍 احكيلي مالك، انا سامعك.', 'ليه بس؟ فضفض وانا معاك.'], expect: 'sad_story' },
  { name: 'joke', k: ['نكته', 'قولي نكته', 'اضحكني', 'عايز نكته'],
    r: ['واحد راح للدكتور قاله: يا دكتور انا بنسى. قاله: من امتى؟ قاله: من امتى ايه؟ 😂',
        'واحد قال لصاحبه: انا هسيب السجاير. قاله: امتى؟ قاله: لما اخلص العلبة دي 😂'] },
  { name: 'bye', k: ['باي', 'مع السلامه', 'همشي', 'يلا سلام'],
    r: ['مع السلامة {n}، متغيبش علينا 🌹', 'في امان الله، نورتني 😍'] },
  { name: 'help', k: ['عايز مساعده', 'ساعدني', 'عندي مشكله', 'ينفع تساعدني'],
    r: ['تحت امرك {n}، احكيلي المشكلة بالتفصيل وانا هحاول اساعدك 🤝'], expect: 'problem' },
]
const QUICK = new Set(['salam', 'howareyou', 'thanks', 'who', 'sad', 'joke', 'bye', 'help'])

// ================= مصنف النوايا =================
const grams = s => {
  const t = ` ${squash(s)} `
  const m = new Map()
  for (let i = 0; i < t.length - 2; i++) { const g = t.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1) }
  return m
}
let docs = [], df = new Map(), N = 1
function weigh(g) {
  const v = new Map(); let n = 0
  for (const [k, c] of g) { const w = (1 + Math.log(c)) * Math.log(1 + N / (1 + (df.get(k) || 0))); v.set(k, w); n += w * w }
  n = Math.sqrt(n) || 1
  for (const [k, w] of v) v.set(k, w / n)
  return { v, n }
}
function buildIndex() {
  docs = []
  for (const it of intents) for (const ex of it.k) docs.push({ intent: it.name, norm: normalize(ex) })
  data.learned.forEach((l, i) => docs.push({ intent: 'L:' + i, norm: normalize(l.q) }))
  df = new Map(); N = docs.length
  for (const d of docs) { d.g = grams(d.norm); for (const k of d.g.keys()) df.set(k, (df.get(k) || 0) + 1) }
  for (const d of docs) d.w = weigh(d.g).v
}
function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a]
  let s = 0
  for (const [k, w] of a) { const x = b.get(k); if (x) s += w * x }
  return s
}
function classify(norm) {
  const tokens = norm.split(' ').filter(Boolean)
  if (!tokens.length) return null
  const q = weigh(grams(norm)).v
  let best = null, second = 0
  for (const d of docs) {
    let s = d.norm === norm ? 1 : cosine(q, d.w)
    if (!best || s > best.score) { second = best?.score || 0; best = { intent: d.intent, score: s } }
    else if (s > second) second = s
  }
  return best ? { ...best, second } : null
}
buildIndex()
const byName = Object.fromEntries(intents.map(i => [i.name, i]))

// ================= ذاكرة + مشاعر =================
const NEG = ['تعبان', 'وحش', 'زعلان', 'مخنوق', 'سيء', 'مضايق', 'محبط', 'زهقان', 'مكتئب', 'حزين']
const POS = ['تمام', 'كويس', 'الحمدلله', 'فل', 'عسل', 'ممتاز', 'حلو', 'بخير', 'مبسوط', 'فرحان']
const sentiment = norm => {
  let s = 0
  for (const w of NEG.map(normalize)) if (norm.includes(w)) s--
  for (const w of POS.map(normalize)) if (norm.includes(w)) s++
  return s
}
function ctxOf(jid) {
  if (!data.users[jid]) data.users[jid] = { name: null, hist: [], count: 0, intro: false, facts: {} }
  const c = data.users[jid]
  c.expect ??= null; c.last ??= ''; c.facts ??= {}
  return c
}
const fill = (s, c) => s.replaceAll('{n}', c.name ? `يا ${c.name}` : pick(NICK))
const pickNew = (arr, c) => { const f = arr.filter(x => x !== c.last); return pick(f.length ? f : arr) }
function extractFacts(raw, c) {
  let m = raw.match(/(?:اسمي|انا اسمي|ناديني)\s+([\p{L}]{2,15})/u)
  if (m) c.name = m[1]
}

// ================= أدوات =================
function tryMath(norm) {
  const e = norm.replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**').replace(/\s/g, '')
  if (!/^[\d+\-*/().%]+$/.test(e) || !/\d/.test(e) || !/[+\-*/%]/.test(e)) return null
  try {
    const v = Function(`"use strict"; return (${e})`)()
    if (typeof v !== 'number' || !isFinite(v)) return null
    return `الناتج: ${Math.round(v * 1e6) / 1e6} 🧮`
  } catch { return null }
}
const cairo = o => new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', ...o })
function tools(norm) {
  if (/(الساعه كام|كام الساعه|الوقت كام|الساعه دلوقتي)/.test(norm)) return `الساعة دلوقتي ${cairo({ hour: '2-digit', minute: '2-digit' })} ⏰`
  if (/(النهارده ايه|النهارده كام|تاريخ النهارده|اليوم ايه)/.test(norm)) return `النهارده ${cairo({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} 📅`
  return tryMath(norm)
}

// ================= Ollama - متصلح: timeout 8 ثواني بس =================
let ollamaOK = null
async function askOllama(c) {
  if (!USE_OLLAMA || ollamaOK === false) return null
  const sys = SYSTEM_PROMPT + `\nالوقت الان في القاهرة: ${cairo({ weekday: 'long', hour: '2-digit', minute: '2-digit' })}` + (c.name ? `\nاسم الشخص: ${c.name}` : '')
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 8000)
    const res = await fetch(OLLAMA_URL, {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL, stream: false, keep_alive: '30m',
        messages: [{ role: 'system', content: sys }, ...c.hist.slice(-12)],
        options: { temperature: 0.65, num_predict: 260, num_ctx: 4096, repeat_penalty: 1.15 },
      }),
    })
    clearTimeout(t)
    if (!res.ok) throw new Error('http ' + res.status)
    const j = await res.json()
    const out = j?.message?.content?.trim()
    if (out) { ollamaOK = true; return out }
  } catch (e) { console.log('Ollama مش شغال، هستخدم المحلي:', e.message); ollamaOK = false }
  return null
}

function smartFallback(raw, norm, tokens, c, sent) {
  if (sent < 0) return fill('حاسس انك مضايق {n} 🤍 احكيلي اللي حصل وانا معاك.', c)
  if (tokens.length <= 2) return pickNew(['ايوه؟ قول 👀', 'سامعك، كمل', 'تحت امرك، عايز ايه؟'], c)
  return pickNew([`وصلتني رسالتك. لو عايز حاجة معينة قولها صريحة، ولو عايز ${OWNER_NAME} اكتب "بلغ ${OWNER_NAME}" وهوصله.`, 'فاهمك. تحب اساعدك في ايه بالظبط؟'], c)
}

// ================= المحرك =================
const ASK_OWNER = /(عبدالله|عبد الله).*(فين|موجود|متاح|مشغول|ممكن|عايز|اكلم|اتكلم)|(عايز|اكلم|اتكلم|ابلغ|بلغ|سلم).*(عبدالله|عبد الله)/
const LEAVE_MSG = /^(بلغ|ابلغ|سلم|قول ل|قوله|ابعت ل|وصل)/
const URGENT = /(عاجل|ضروري جدا|ضروري|طارئ|مهم جدا|حالا)/

async function getReply(jid, raw, pushName) {
  const c = ctxOf(jid)
  const norm = normalize(raw)
  const tokens = norm.split(' ').filter(Boolean)
  c.count++
  extractFacts(raw, c)
  if (!c.name && pushName && pushName.length < 16) c.name = pushName.split(' ')[0]
  const sent = sentiment(norm)
  let intro = ''
  if (!c.intro) { c.intro = true; intro = `اهلا بيك 👋 انا ${BOT_NAME}، برد على الرسايل بدل ${OWNER_NAME} لما ميبقاش متاح.\n\n` }

  if (c.expect === 'leave_msg' || LEAVE_MSG.test(norm) || URGENT.test(norm)) {
    const wasUrgent = URGENT.test(norm)
    c.expect = null
    const body = raw.replace(/^(بلغ|ابلغ|سلم|قول ل|قوله|ابعت ل|وصل)\s*(عبد ?الله)?\s*/u, '').trim() || raw
    await relayToOwner(jid, c, body, wasUrgent)
    return intro + `تمام ${c.name ? 'يا ' + c.name : ''} ✅ وصلت رسالتك لـ${OWNER_NAME}. هيرد عليك اول ما يفضى.`
  }
  if (ASK_OWNER.test(norm)) {
    c.expect = 'leave_msg'
    return intro + `${OWNER_NAME} مش متاح دلوقتي. اكتبلي رسالتك وانا اوصلهاله فورًا 😉`
  }
  if (c.expect === 'mood' && tokens.length <= 6) {
    if (sent < 0) { c.expect = 'sad_story'; return intro + fill('ألف سلامة عليك {n} 🤍 مالك؟ احكيلي وانا سامعك.', c) }
    if (sent > 0) { c.expect = null; return intro + fill('ربنا يديم عليك الفرحة {n} 😍 ايه الجديد؟', c) }
  }
  const tool = tools(norm)
  if (tool) return intro + tool

  const cls = classify(norm)
  const confident = cls && cls.score >= 0.55
  if (cls && cls.intent.startsWith('L:') && cls.score >= 0.72) {
    const l = data.learned[+cls.intent.slice(2)]
    if (l) return intro + fill(l.a, c)
  }
  const it = confident && !cls.intent.startsWith('L:') ? byName[cls.intent] : null
  if (it && QUICK.has(it.name) && tokens.length <= 4) {
    c.expect = it.expect || null
    return intro + fill(pickNew(it.r, c), c)
  }
  c.hist.push({ role: 'user', content: raw })
  if (c.hist.length > 24) c.hist.splice(0, c.hist.length - 24)
  const ai = await askOllama(c)
  if (ai) { c.expect = null; return intro + ai }
  c.hist.pop()
  if (it) { c.expect = it.expect || null; return intro + fill(pickNew(it.r, c), c) }
  return intro + smartFallback(raw, norm, tokens, c, sent)
}

async function relayToOwner(jid, c, body, urgent) {
  if (!globalThis.__sock) return
  const num = jid.split('@')[0]
  const who = c.name ? `${c.name} (${num})` : num
  await globalThis.__sock.sendMessage(OWNER_JID, { text: `${urgent ? '🚨 عاجل' : '📩 رسالة'} من ${who}:\n\n${body}\n\nللرد: wa.me/${num}` })
}

// ================= أوامر صاحب البوت =================
async function ownerCommand(sock, chat, text) {
  const say = t => sock.sendMessage(chat, { text: t })
  if (text.startsWith('.علمه')) {
    const [q, a] = text.slice(5).split('=>').map(s => s?.trim())
    if (!q || !a) return say('الصيغة:\n.علمه السؤال => الرد')
    data.learned.push({ q, a }); buildIndex(); save()
    return say(`✅ اتعلمت. (${data.learned.length} إجابة محفوظة)`)
  }
  if (text.startsWith('.انسى')) {
    const q = text.slice(5).trim()
    const n = data.learned.length
    data.learned = data.learned.filter(l => l.q !== q); buildIndex(); save()
    return say(n === data.learned.length ? 'ملقتش السؤال ده.' : '🗑️ اتمسح.')
  }
  if (text === '.المتعلم') return say(data.learned.map((l, i) => `${i + 1}. ${l.q} => ${l.a}`).join('\n') || 'لسه معلمتنيش حاجة.')
  if (text === '.احصائيات') return say(`👥 ${Object.keys(data.users).length} شخص\n🧠 ${data.learned.length} إجابة متعلمة\n🤖 Ollama: ${ollamaOK === null ? 'لسه' : ollamaOK ? 'شغال' : 'واقف'}`)
  if (text === '.ايقاف') { data.paused = true; save(); return say('⏸️ البوت وقف الردود.') }
  if (text === '.تشغيل') { data.paused = false; save(); return say('▶️ البوت شغال.') }
  return say('الأوامر:\n.علمه سؤال => رد\n.انسى سؤال\n.المتعلم\n.احصائيات\n.ايقاف\n.تشغيل')
}

// ================= الإرسال - متصلح =================
const pending = new Map(), chains = new Map(), rate = new Map()
function enqueue(sock, msg, raw) {
  const jid = msg.key.remoteJid
  const now = Date.now()
  const r = (rate.get(jid) || []).filter(t => now - t < 60000)
  r.push(now); rate.set(jid, r)
  if (r.length > MAX_PER_MIN) return
  let p = pending.get(jid)
  if (!p) { p = { texts: [], msg, timer: null }; pending.set(jid, p) }
  p.texts.push(raw); p.msg = msg
  clearTimeout(p.timer)
  p.timer = setTimeout(() => {
    pending.delete(jid)
    const job = () => respond(sock, jid, p.texts.join('\n'), p.msg)
    chains.set(jid, (chains.get(jid) || Promise.resolve()).then(job).catch(e => console.error('خطأ:', e.message)))
  }, DEBOUNCE_MS)
}

// دي كانت الغلطة الأساسية - شلت readMessages و presenceSubscribe اللي كانوا بيبوظوا الإرسال
async function sendHuman(sock, jid, msg, reply) {
  try { await sock.sendPresenceUpdate('composing', jid) } catch {}
  await sleep(Math.min(1500, 400 + reply.length * 12))
  try { await sock.sendPresenceUpdate('paused', jid) } catch {}
  // الإرسال نفسه
  const sent = await sock.sendMessage(jid, { text: reply })
  console.log('📤 اتبعت فعلا لـ', jid, '| id:', sent?.key?.id)
  return sent
}

async function respond(sock, jid, raw, msg) {
  try {
    console.log('🤖 بجهز رد على:', jid, '| الرسالة:', raw)
    const reply = await getReply(jid, raw, msg.pushName)
    const c = ctxOf(jid)
    await sendHuman(sock, jid, msg, reply)
    console.log('✅ اتبعت رد على', jid)
    c.hist.push({ role: 'assistant', content: reply })
    c.last = reply
    if (c.hist.length > 24) c.hist.splice(0, c.hist.length - 24)
    save()
  } catch (e) {
    console.error('❌ فشل الإرسال:', e.message)
    // محاولة أخيرة بدون typing
    try { await sock.sendMessage(jid, { text: await getReply(jid, raw, msg.pushName) }) } catch (e2) { console.error('❌ فشل تاني:', e2.message) }
  }
}

// ================= الاتصال =================
const bare = j => (j || '').split(':')[0].split('@')[0]

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  let version
  try { version = (await fetchLatestBaileysVersion()).version } catch { version = [2, 3000, 1015901307] }
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: !PAIR_NUMBER, logger: P({ level: 'silent' }), browser: ['Ubuntu', 'Chrome', '20.0.0'] })
  globalThis.__sock = sock
  sock.ev.on('creds.update', saveCreds)

  if (PAIR_NUMBER && !state.creds.registered) {
    setTimeout(async () => {
      try { const c = await sock.requestPairingCode(PAIR_NUMBER.replace(/\D/g, '')); console.log('🔑 كود الربط:', c.match(/.{1,4}/g).join('-')) }
      catch (e) { console.log('pairing error:', e.message) }
    }, 3000)
  }

  sock.ev.on('connection.update', async u => {
    if (u.connection === 'open') {
      console.log(`✅ ${BOT_NAME} اونلاين - رقمي: ${sock.user?.id}`)
      if (USE_OLLAMA) {
        try { const r = await fetch(OLLAMA_URL.replace('/api/chat', '/api/tags')); ollamaOK = r.ok } catch { ollamaOK = false }
        console.log(ollamaOK ? `🧠 Ollama شغال (${OLLAMA_MODEL})` : '⚠️ Ollama مش شغال، هستخدم المحرك المحلي بس')
      }
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode
      console.log('اتقفل، كود:', code)
      if (code === DisconnectReason.loggedOut) return console.log('❌ logout، امسح فولدر auth_info وشغل تاني')
      setTimeout(start, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        if (!msg.message) continue
        const from = msg.key.remoteJid
        if (!from || from === 'status@broadcast') continue
        if (msg.key.fromMe) {
          // لو انت بعت أمر من رقمك لنفسك، نفذه
          const mMe = normalizeMessageContent(msg.message) || msg.message
          const rawMe = (mMe.conversation || mMe.extendedTextMessage?.text || '').trim()
          if (rawMe.startsWith('.')) await ownerCommand(sock, from, rawMe)
          continue
        }

        // تجاهل الرسايل القديمة - متصلح: Timestamp رقم مش object
        const ts = Number(msg.messageTimestamp || 0)
        if (ts && Date.now() / 1000 - ts > 120) continue

        const m = normalizeMessageContent(msg.message) || msg.message
        const raw = (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '').trim()
        console.log(`📨 من: ${from} | نص: ${raw.slice(0, 60)}`)

        // لو صاحب البوت بعت من رقمه للبوت
        if (from === OWNER_JID) {
          if (raw.startsWith('.')) { await ownerCommand(sock, from, raw); continue }
        }

        if (data.paused) continue
        if (from.endsWith('@g.us') && !ALLOW_GROUPS) continue

        if (raw) enqueue(sock, msg, raw)
        else {
          let reply = null
          if (m.audioMessage) reply = 'مش قادر اسمع الفويس دلوقتي 🎧 ابعتهالي كتابة وانا معاك'
          else if (m.stickerMessage) reply = pick(['ستيكر جامد 😂', 'هههه حلو الاستيكر ده 😂'])
          else if (m.imageMessage) reply = 'صورة حلوة 😍 قولي عايز ايه بيها؟'
          if (reply) await sendHuman(sock, from, msg, reply)
        }
      } catch (e) { console.error('خطأ في الرسالة:', e.message) }
    }
  })
}

process.on('unhandledRejection', e => console.log('unhandled:', e?.message || e))
process.on('uncaughtException', e => console.log('uncaught:', e?.message || e))
start()