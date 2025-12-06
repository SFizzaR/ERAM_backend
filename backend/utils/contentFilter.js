// utils/contentFilter.js
const filterContent = (text) => {
  const lower = text.toLowerCase();

  // ────────────────────────── ENGLISH DANGEROUS MYTHS & HARMFUL CLAIMS ──────────────────────────
  const ENGLISH_DANGEROUS = [
    // Fake "cures"
    'mms', 'miracle mineral solution', 'bleach', 'chlorine dioxide', 'cd protocol',
    'chelation cures autism', 'hyperbaric oxygen cures autism', 'hb ot',
    'lupron protocol', 'stem cell cure', 'cure autism', 'recover autism',
    'autism is reversible', 'detox autism', 'biomedical treatment cures',
    'gaps diet cures autism', 'keto cures autism',

    // Anti-vaccine & conspiracy
    'vaccines cause autism', 'vaccine injury', 'mmr caused autism',
    'autism epidemic from vaccines', 'andrew wakefield',

    // Harmful language against autistic people
    'low functioning', 'high functioning', 'severely autistic',
    'retard', 'retarded', 'autistic retard', 'special needs retard',
    'burden on family', 'better off dead', 'should have been aborted',
    'vegetable', 'not a real person', 'soul-less', 'possessed'
  ];

  // ────────────────────────── ROMAN URDU + PAKISTANI SLURS & INSULTS ──────────────────────────
  const ROMAN_URDU_BAD = [
    // Slurs & insults
    'pagal', 'pagal khanay ka', 'deewana', 'mental', 'dimaghi mareez',
    'bewaqoof', 'chutiya', 'harami', 'kanjar', 'randi', 'bhenchod', 'madarchod',
    'ghatia', 'nikamma', 'nalayak', 'bakwas band kar', 'fuzool baatein',

    // Harmful autism-related phrases in Roman Urdu
    'autism ka ilaj', 'autism theek ho sakta hai', 'autism khatam karne ka tareeka',
    'bleach se autism theek', 'vaccine ne autism diya', 'teeka ne bacha bigad diya',
    'ye bacha kabhi theek nahi hoga', 'is ko mar dalo', 'aisi aulad se behtar abortion',
    'ye sirf pareshani hai', 'ye janwar hai', 'shaytan ka bacha',

    // Fake treatments
    'homeo se autism theek', 'hakeem se ilaj', 'dua se autism chala jayega',
    'jinnat ki wajah se autism', 'nazar lag gayi is liye'
  ];

  // Combine all
  const ALL_DANGEROUS = [...ENGLISH_DANGEROUS, ...ROMAN_URDU_BAD];

  for (const phrase of ALL_DANGEROUS) {
    if (lower.includes(phrase)) {
      return {
        blocked: true,
        reason: 'Contains harmful, misleading, or abusive content'
      };
    }
  }

  return { blocked: false };
};

module.exports = { filterContent };