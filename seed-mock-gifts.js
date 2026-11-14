// Fills logs/mock-gifts/ with 30 days of fake Gift history, so `MOCK=1`
// shows a populated /gifts page (today / yesterday / 7 / 30 days) without a
// real live. Only touches the mock folder -- the real history in logs/ is
// never read or written. Re-running replaces the previous mock days.
//
//   npm run seed:gifts            30 days ending now
//   npm run seed:gifts -- 7       7 days

const fs = require('fs');
const path = require('path');

const DAYS = Math.max(1, Math.min(30, Number(process.argv[2]) || 30));
const DIR = path.join(__dirname, 'logs', 'mock-gifts');
const HOUR = 60 * 60 * 1000;

const ROSE_IMAGE = 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png';

// Real TikTok diamond values; weight = how often it's picked (cheap gifts
// dominate the count, a few expensive ones dominate the diamonds).
const GIFTS = [
  { name: 'Rose', diamonds: 1, weight: 40, image: ROSE_IMAGE },
  { name: 'TikTok', diamonds: 1, weight: 18 },
  { name: 'Finger Heart', diamonds: 5, weight: 16 },
  { name: 'Rosa', diamonds: 10, weight: 9 },
  { name: 'Perfume', diamonds: 20, weight: 6 },
  { name: 'Doughnut', diamonds: 30, weight: 4 },
  { name: 'Hand Hearts', diamonds: 100, weight: 4 },
  { name: 'Corgi', diamonds: 299, weight: 1.5 },
  { name: 'Galaxy', diamonds: 1000, weight: 1 },
  { name: 'Lion', diamonds: 29999, weight: 0.03 },
];

// A few regulars carry most of the diamonds, like a real fan base.
const USERS = [
  ['ploy.ploy', 'PloyPloy'], ['maprang_kk', 'มะปราง'], ['toychan', 'Toy Chan 12345'], ['bigboss.th', 'บอสใหญ่'],
  ['nnmin', 'nn.min'], ['fahsai', 'ฟ้าใส'], ['kiki_88', 'kiki_88'], ['user4512512512', 'user4512512512'],
  ['nampeung_99', 'น้ำผึ้ง'], ['kai_gamer', 'ไก่ เกมเมอร์'], ['pim.streamfan', 'พิม 🌸'], ['tanawat_th', 'ธนวัฒน์'],
  ['night_owl', 'Night Owl 🦉'], ['oat.oat', 'โอ๊ต'], ['meow4', 'น้องแมว ม.4/3'],
];

const pick = (list, weightOf) => {
  let r = Math.random() * list.reduce((sum, item) => sum + weightOf(item), 0);
  return list.find((item) => (r -= weightOf(item)) < 0) || list[0];
};
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function gift(t) {
  const [user, nickname] = pick(USERS, (u) => 1 / (USERS.indexOf(u) + 1));
  const g = pick(GIFTS, (x) => x.weight);
  // Cheap gifts come in streaks; expensive ones one or two at a time.
  const repeatCount = g.diamonds <= 10 ? 1 + Math.floor(Math.random() ** 2 * 30) : 1 + Math.floor(Math.random() * 2);
  return {
    t: Math.round(t),
    user,
    nickname,
    avatarUrl: `https://i.pravatar.cc/150?u=${encodeURIComponent(user)}`,
    giftName: g.name,
    giftImage: g.image || '',
    repeatCount,
    diamondCount: g.diamonds * repeatCount,
  };
}

fs.mkdirSync(DIR, { recursive: true });
// Clear the previous seed first, or a day that's a day off this time would
// keep last run's gifts.
for (const file of fs.readdirSync(DIR)) {
  if (/^gifts-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) fs.unlinkSync(path.join(DIR, file));
}
const now = Date.now();
let totalEvents = 0;
let totalDiamonds = 0;

for (let i = DAYS - 1; i >= 0; i--) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - i);
  const isToday = i === 0;

  // One live per day, ~19:00-23:30, a bit longer and busier on weekends;
  // about one day in seven is a day off. Today's live is the one running
  // now: it started 3 hours ago.
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  if (!isToday && Math.random() < 1 / 7) continue;
  const start = isToday ? now - 3 * HOUR : day.getTime() + (19 + Math.random()) * HOUR;
  const end = isToday ? now : start + (weekend ? 4 : 3) * HOUR;
  const count = Math.round((weekend ? 140 : 90) * (0.7 + Math.random() * 0.6));

  const events = [];
  for (let n = 0; n < count; n++) {
    // Gifts cluster toward the second half of a live.
    events.push(gift(start + Math.random() ** 0.7 * (end - start)));
  }
  events.sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(DIR, `gifts-${dateKey(day)}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  totalEvents += events.length;
  totalDiamonds += events.reduce((sum, e) => sum + e.diamondCount, 0);
}

console.log(`Wrote ${totalEvents} mock gifts (${totalDiamonds.toLocaleString()} diamonds) over ${DAYS} days to ${DIR}`);
console.log('Start the server with MOCK=1 to see them on /gifts.');
