/* Written by tools/abecedarian-corpus.mjs — do not edit by hand.

   Every headword of four Hunspell spelling dictionaries, folded to A-Z, put
   through abecedarian/abc.js. counts[d] is how many of that dictionary's words
   need exactly d swaps of the alphabet; "unsortable" is how many no ordering
   can sort at all, and words = sortable + unsortable. Sources are pinned to
   wooorm/dictionaries @ 8cfea40. */

var ABC_CORPUS = {
  pin: "8cfea40",
  maxDistance: 10,
  languages: [
  { id: "en", name: "English", dict: "SCOWL / en_US Hunspell",
    words: 47293, sortable: 18332, unsortable: 28961,
    counts: [543, 3288, 5651, 5199, 2566, 843, 204, 35, 3, 0, 0] },
  { id: "es", name: "Spanish", dict: "RLA es_ES Hunspell",
    words: 54537, sortable: 10485, unsortable: 44052,
    counts: [171, 1191, 3048, 3369, 1900, 652, 137, 17, 0, 0, 0] },
  { id: "fr", name: "French", dict: "Dicollecte / Grammalecte fr",
    words: 73293, sortable: 16542, unsortable: 56751,
    counts: [313, 2158, 4609, 5009, 2922, 1178, 287, 56, 10, 0, 0] },
  { id: "de", name: "German", dict: "igerman98 de_DE Hunspell",
    words: 47707, sortable: 10300, unsortable: 37407,
    counts: [198, 1282, 2674, 3019, 1883, 855, 281, 76, 23, 7, 2] }
  ]
};

if (typeof module !== 'undefined') module.exports = ABC_CORPUS;
