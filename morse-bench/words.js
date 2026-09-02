/* What a run is made of.

   Two sources, and the difference between them is what the score is a score OF.
   Ordinary English words are what a typing test uses and what a hand actually
   has to send, but English is not evenly spread over the alphabet: E is one
   element and Q is four, and a run of common words is mostly the cheap end of
   the code. Five-character groups are the trade's own practice material — the
   licence exam sent nothing else — and drawn evenly they put every character on
   the same footing, so a slow letter shows up as a slow letter rather than as a
   letter that happened not to come round.

   The exam's groups also carried four punctuation marks. They are left out
   here, because a six-element pattern every few groups is a different exercise
   and would swamp a ten-word run. */

const Material = (function () {
  "use strict";

  const WORDS = [
    "about", "above", "after", "again", "against", "air", "all", "almost",
    "alone", "along", "already", "also", "always", "among", "and", "animal",
    "another", "answer", "any", "appear", "area", "arm", "around", "ask",
    "away", "back", "bad", "ball", "base", "beauty", "become", "been",
    "before", "began", "begin", "behind", "being", "believe", "below", "best",
    "better", "between", "big", "bird", "black", "block", "blue", "board",
    "boat", "body", "book", "born", "both", "bottom", "box", "boy", "bread",
    "break", "bright", "bring", "broad", "brother", "brought", "build", "busy",
    "but", "call", "came", "cannot", "care", "carry", "case", "catch", "cause",
    "cell", "center", "century", "certain", "chance", "change", "chart",
    "check", "chief", "child", "choose", "circle", "city", "class", "clean",
    "clear", "close", "cloud", "coast", "cold", "colour", "come", "common",
    "company", "compare", "complete", "consider", "contain", "control", "copy",
    "corner", "cost", "could", "count", "country", "course", "cover", "cross",
    "crowd", "current", "cut", "dark", "data", "day", "dead", "deal", "decide",
    "deep", "describe", "design", "detail", "develop", "did", "differ",
    "direct", "distant", "divide", "does", "dog", "done", "door", "double",
    "down", "draw", "dream", "drive", "drop", "dry", "during", "each", "early",
    "earth", "ease", "east", "edge", "effect", "egg", "eight", "either",
    "electric", "element", "else", "end", "enough", "enter", "equal", "even",
    "evening", "ever", "every", "exact", "example", "except", "expect", "eye",
    "face", "fact", "fall", "family", "far", "farm", "fast", "father", "fear",
    "feel", "feet", "few", "field", "fig", "figure", "fill", "final", "find",
    "fine", "finger", "finish", "fire", "first", "fish", "five", "flat", "floor",
    "flow", "fly", "follow", "food", "foot", "force", "forest", "form",
    "forward", "found", "four", "free", "fresh", "friend", "front",
    "full", "game", "garden", "gas", "gave", "general", "get", "girl", "give",
    "glass", "gold", "gone", "good", "govern", "grand", "grass", "great",
    "green", "grew", "ground", "group", "grow", "guess", "guide", "gun", "had",
    "hair", "half", "hand", "happen", "happy", "hard", "has", "hat", "have",
    "head", "hear", "heart", "heat", "heavy", "held", "help", "here", "high",
    "hill", "history", "hold", "hole", "home", "hope", "horse", "hot", "hour",
    "house", "how", "huge", "human", "hundred", "hunt", "hurry", "ice", "idea",
    "inch", "include", "indeed", "industry", "insect", "inside", "instant",
    "iron", "island", "job", "join", "joy", "jump", "just", "keep", "kept",
    "key", "kind", "king", "knew", "know", "lady", "lake", "land", "language",
    "large", "last", "late", "laugh", "law", "lay", "lead", "learn", "least",
    "leave", "led", "left", "leg", "length", "less", "let", "letter", "level",
    "lie", "life", "lift", "light", "like", "line", "list", "listen", "little",
    "live", "load", "local", "lone", "long", "look", "lost", "lot", "loud",
    "love", "low", "machine", "made", "main", "major", "make", "man", "many",
    "map", "march", "mark", "market", "master", "match", "matter", "may",
    "mean", "measure", "meat", "meet", "melody", "member", "men", "metal",
    "method", "middle", "might", "mile", "milk", "mind", "mine", "minute",
    "miss", "mix", "modern", "moment", "money", "month", "moon", "more",
    "morning", "most", "mother", "motion", "mount", "mouth", "move", "much",
    "music", "must", "name", "nation", "natural", "near", "neck", "need",
    "never", "new", "next", "night", "nine", "noise", "north", "nose", "note",
    "nothing", "notice", "noun", "now", "number", "object", "ocean", "off",
    "offer", "office", "often", "oil", "old", "once", "one", "only", "open",
    "operate", "opposite", "order", "organ", "other", "out", "over", "own",
    "page", "paint", "pair", "paper", "part", "party", "pass", "past", "path",
    "pattern", "pay", "people", "perhaps", "period", "person", "phrase",
    "pick", "picture", "piece", "place", "plain", "plan", "plane", "plant",
    "play", "please", "point", "poor", "port", "possible", "post", "pound",
    "power", "practice", "prepare", "present", "press", "pretty", "print",
    "problem", "process", "produce", "product", "proper", "protect", "prove",
    "provide", "pull", "push", "put", "quart", "queen", "question", "quick",
    "quiet", "quite", "quiz", "race", "radio", "rail", "rain", "raise",
    "range", "rate", "rather", "reach", "read", "ready", "real", "reason",
    "receive", "record", "red", "region", "remain", "remember", "repeat",
    "reply", "report", "rest", "result", "return", "rich", "ride", "right",
    "ring", "rise", "river", "road", "rock", "roll", "room", "root", "rope",
    "rose", "round", "row", "rule", "run", "safe", "said", "sail", "salt",
    "same", "sand", "save", "saw", "say", "scale", "school", "science", "sea",
    "search", "season", "seat", "second", "section", "see", "seed", "seem",
    "self", "sell", "send", "sense", "sent", "sentence", "separate", "serve",
    "set", "settle", "seven", "several", "shall", "shape", "share", "sharp",
    "she", "ship", "shoe", "shop", "shore", "short", "should", "shoulder",
    "show", "side", "sight", "sign", "silent", "silver", "similar", "simple",
    "since", "sing", "single", "sister", "sit", "six", "size", "skill", "skin",
    "sky", "sleep", "slow", "small", "smell", "smile", "snow", "soft", "soil",
    "sold", "soldier", "solve", "some", "son", "song", "soon", "sound",
    "south", "space", "speak", "special", "speed", "spell", "spend", "spoke",
    "spot", "spread", "spring", "square", "stand", "star", "start", "state",
    "station", "stay", "steam", "steel", "step", "stick", "still", "stone",
    "stood", "stop", "store", "storm", "story", "straight", "strange",
    "stream", "street", "strong", "student", "study", "subject", "success",
    "such", "sudden", "sugar", "suit", "summer", "sun", "supply", "support",
    "sure", "surface", "surprise", "sweet", "swim", "syllable", "symbol",
    "system", "table", "tail", "take", "talk", "tall", "teach", "team", "tell",
    "ten", "term", "test", "than", "thank", "that", "them", "then", "there",
    "these", "they", "thick", "thin", "thing", "think", "third", "this",
    "those", "though", "thought", "thousand", "three", "through", "throw",
    "thus", "tie", "time", "tiny", "tire", "today", "together", "told",
    "tone", "too", "took", "tool", "top", "total", "touch", "toward", "town",
    "track", "trade", "train", "travel", "tree", "trip", "trouble", "truck",
    "true", "try", "tube", "turn", "twelve", "twenty", "two", "type", "under",
    "unit", "until", "upon", "usual", "valley", "value", "verb", "very",
    "view", "village", "visit", "voice", "vowel", "wait", "walk", "wall",
    "want", "warm", "wash", "watch", "water", "wave", "way", "wear", "weather",
    "week", "weight", "well", "went", "were", "west", "what", "wheel", "when",
    "where", "whether", "which", "while", "white", "who", "whole", "why",
    "wide", "wife", "wild", "will", "wind", "window", "wing", "winter", "wire",
    "wish", "with", "woman", "wonder", "wood", "word", "work", "world",
    "would", "write", "wrong", "wrote", "yard", "year", "yellow", "yes", "yet",
    "you", "young",
  ].map((w) => w.toUpperCase());

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /* No word twice in one run where the pool allows it, so a short run cannot
     come out as the same word three times and read as a broken generator. */
  function draw(source, n) {
    const out = [];
    if (source === "groups") {
      for (let i = 0; i < n; i += 1) {
        let group = "";
        for (let c = 0; c < 5; c += 1) group += pick(ALPHABET.split(""));
        out.push(group);
      }
      return out;
    }
    const seen = new Set();
    while (out.length < n) {
      const word = pick(WORDS);
      if (seen.has(word) && seen.size < WORDS.length) continue;
      seen.add(word);
      out.push(word);
    }
    return out;
  }

  return { WORDS: WORDS, ALPHABET: ALPHABET, draw: draw };
})();
