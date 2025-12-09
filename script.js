class BilingualMerger {
    constructor() {
        this.wpm = 150; // words per minute
    }

    // Count words in a string
    countWords(text) {
        const trimmed = text.trim();
        if (!trimmed) return 0;
        // Treat "«...»" (with spaces) as a single token for word counting purposes.
        // Regex: match strict French quote pattern OR standard non-whitespace sequence.
        // Note: [^»] means any char except closing quote.
        const tokens = trimmed.match(/«[^»]+»|\S+/g) || [];
        return tokens.length;
    }

    // Estimate speaking duration in seconds for a given word count OR text content
    estimateDuration(input) {
        if (typeof input === 'number') {
            return (input / this.wpm) * 60;
        }

        let text = input || '';
        // 1. Clean separators exactly like PracticeController
        text = text.replace(/[*]{3,}|[-]{3,}/g, ' ').replace(/\s+/g, ' ');

        // 2. Handle English quotes (simple clean) - matching PracticeController
        text = text.replace(/"\s+([^"]*?)\s+"/g, '"$1"');

        // 3. Split sentences - matching PracticeController
        // Note: This regex consumes the space after punctuation, splitting there.
        const sentences = text.replace(/([.!?])\s+/g, '$1|').split('|');

        let totalUnits = 0;

        for (const sentText of sentences) {
            const trimmed = sentText.trim();
            if (!trimmed) continue;

            // 4. Parse words (using the quote-aware regex matching PracticeController/countWords)
            const words = trimmed.match(/«[^»]+»|\S+/g) || [];

            // Base units for words
            totalUnits += words.length;

            // Mid-sentence pauses (1 unit)
            for (const word of words) {
                if (',;:'.includes(word.slice(-1))) {
                    totalUnits += 1;
                }
                // Slide header pause (treat # as hard punctuation/double pause)
                if (word === '#') {
                    totalUnits += 2;
                }
            }

            // End-sentence pause (2 units)
            // Check the last character of the full sentence text
            const lastChar = trimmed.slice(-1);
            if ('.!?'.includes(lastChar)) {
                totalUnits += 2;
            }
        }

        return (totalUnits / this.wpm) * 60;
    }

    // Split text into paragraphs (normalize line endings; break on blank lines)
    parseParagraphs(text) {
        const normalized = text.replace(/\r\n?/g, '\n');
        return normalized
            .split(/\n\s*\n+/)
            .map(p => p.trim())
            .filter(p => p.length > 0);
    }

    // Split slide notes by headings starting with "#"
    parseSlides(text) {
        const lines = text.split(/\r?\n/);
        const slides = [];
        let current = null;
        for (const line of lines) {
            if (/^\s*#/.test(line)) {
                if (current) {
                    slides.push({
                        title: current.title,
                        body: current.bodyLines.join('\n').trim()
                    });
                }
                current = { title: line.trim(), bodyLines: [] };
            } else if (current) {
                current.bodyLines.push(line);
            }
        }
        if (current) {
            slides.push({
                title: current.title,
                body: current.bodyLines.join('\n').trim()
            });
        }
        return slides.map(s => {
            const paragraphs = this.parseParagraphs(s.body);
            const words = paragraphs.reduce((sum, p) => sum + this.countWords(p), 0);
            return {
                ...s,
                body: s.body.trim(),
                paragraphs,
                words
            };
        });
    }

    // Merge paragraphs pairwise so each paragraph number appears once (either EN or FR).
    // Chooses language per paragraph to keep totals close, and uses block time as a
    // "streak" target before encouraging a switch.
    merge(englishText, frenchText, options) {
        const baseBlockTime = parseInt(options.blockTime, 10) || 45;

        const enParagraphs = this.parseParagraphs(englishText).map(text => ({
            text,
            words: this.countWords(text)
        }));
        const frParagraphs = this.parseParagraphs(frenchText).map(text => ({
            text,
            words: this.countWords(text)
        }));

        const totalPairs = Math.max(enParagraphs.length, frParagraphs.length);

        let enWordsUsed = 0;
        let frWordsUsed = 0;
        let enDur = 0;
        let frDur = 0;
        let deltaSec = 0; // positive => English ahead in speaking time
        let streakLang = null;
        let streakDuration = 0;
        let streakCount = 0;
        const outputParas = [];
        const choices = [];

        const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
        const totalParas = enParagraphs.length + frParagraphs.length;
        const totalParaSec = enParagraphs.reduce((sum, p) => sum + this.estimateDuration(p.text), 0)
            + frParagraphs.reduce((sum, p) => sum + this.estimateDuration(p.text), 0);
        const avgParaSec = totalParas > 0 ? totalParaSec / totalParas : 5;
        const maxAllowedStreak = Math.max(1, Math.floor(totalPairs / 2) || 1);
        const targetStreakCount = clamp(
            Math.round(baseBlockTime / avgParaSec),
            1,
            Math.max(2, maxAllowedStreak)
        );

        for (let i = 0; i < totalPairs; i++) {
            const enPara = enParagraphs[i] || { text: '', words: 0 };
            const frPara = frParagraphs[i] || { text: '', words: 0 };
            if (!enPara.text && !frPara.text) continue;

            // Honor the requested starting language on the first real paragraph.
            if (!streakLang) {
                if (options.startLang === 'en' && enPara.words > 0) {
                    const chosenPara = enPara;
                    outputParas.push(chosenPara.text);
                    enWordsUsed += chosenPara.words;
                    const dur = this.estimateDuration(chosenPara.text);
                    enDur += dur;
                    deltaSec += dur;
                    streakLang = 'en';
                    streakDuration = dur;
                    streakCount = 1;
                    continue;
                } else if (options.startLang === 'fr' && frPara.words > 0) {
                    const chosenPara = frPara;
                    outputParas.push(chosenPara.text);
                    frWordsUsed += chosenPara.words;
                    const dur = this.estimateDuration(chosenPara.text);
                    frDur += dur;
                    deltaSec -= dur;
                    streakLang = 'fr';
                    streakDuration = dur;
                    streakCount = 1;
                    continue;
                }
            }

            const mustSwitch = streakLang && streakCount >= targetStreakCount;

            const enParaDur = this.estimateDuration(enPara.text);
            const frParaDur = this.estimateDuration(frPara.text);

            const enProjectedStreak = streakLang === 'en' ? streakDuration + enParaDur : enParaDur;
            const frProjectedStreak = streakLang === 'fr' ? streakDuration + frParaDur : frParaDur;

            const enScore = enPara.words === 0
                ? Number.POSITIVE_INFINITY
                : Math.abs((enWordsUsed + enPara.words) - frWordsUsed)
                + (streakLang === 'fr' && !mustSwitch ? (targetStreakCount - streakCount) * 2 : 0)
                + (streakLang === 'en' && mustSwitch ? 1e6 : 0);

            const frScore = frPara.words === 0
                ? Number.POSITIVE_INFINITY
                : Math.abs(enWordsUsed - (frWordsUsed + frPara.words))
                + (streakLang === 'en' && !mustSwitch ? (targetStreakCount - streakCount) * 2 : 0)
                + (streakLang === 'fr' && mustSwitch ? 1e6 : 0);

            let chosenLang;
            if (enScore < frScore) {
                chosenLang = 'en';
            } else if (frScore < enScore) {
                chosenLang = 'fr';
            } else {
                // Tie-break: pick the trailing language; otherwise use start preference.
                const wordGap = enWordsUsed - frWordsUsed;
                if (wordGap > 0 && frPara.words > 0) chosenLang = 'fr';
                else if (wordGap < 0 && enPara.words > 0) chosenLang = 'en';
                else chosenLang = options.startLang;
            }

            const chosenPara = chosenLang === 'en' ? enPara : frPara;
            const altLang = chosenLang === 'en' ? 'fr' : 'en';
            const altPara = altLang === 'en' ? enPara : frPara;

            outputParas.push(chosenPara.text);
            choices.push({
                lang: chosenLang,
                words: chosenPara.words,
                altLang,
                altWords: altPara.words,
                altText: altPara.text
            });

            if (chosenLang === 'en') {
                enWordsUsed += chosenPara.words;
                enDur += this.estimateDuration(chosenPara.text);
                deltaSec += this.estimateDuration(chosenPara.text);
            } else {
                frWordsUsed += chosenPara.words;
                frDur += this.estimateDuration(chosenPara.text);
                deltaSec -= this.estimateDuration(chosenPara.text);
            }

            if (streakLang === chosenLang) {
                streakDuration += this.estimateDuration(chosenPara.text);
                streakCount += 1;
            } else {
                streakLang = chosenLang;
                streakDuration = this.estimateDuration(chosenPara.text);
                streakCount = 1;
            }
        }

        // Last-paragraph balancing: swap the final chosen paragraph to the opposite language if it improves overall balance.
        if (choices.length > 0) {
            const lastIdx = choices.length - 1;
            const lastChoice = choices[lastIdx];
            if (lastChoice.altWords > 0) {
                const currentDelta = Math.abs(enWordsUsed - frWordsUsed);
                let swapEn = enWordsUsed;
                let swapFr = frWordsUsed;
                if (lastChoice.lang === 'en') {
                    swapEn = enWordsUsed - lastChoice.words;
                    swapFr = frWordsUsed + lastChoice.altWords;
                } else {
                    swapEn = enWordsUsed + lastChoice.altWords;
                    swapFr = frWordsUsed - lastChoice.words;
                }
                const swapDelta = Math.abs(swapEn - swapFr);
                if (swapDelta < currentDelta) {
                    // Note: Swapping logic tracks words but updating duration is complex here.
                    // Given this is edge case optimization, traversing again or simplifying is acceptable.
                    // We will re-calculate duration at the end if strict accuracy needed, or just update roughly.
                    // Let's rely on re-summing or just accepting slight inaccuracy for this edge case swap.
                    // Actually, let's just update enWordsUsed/frWordsUsed as it does.
                    // Duration stats might be slightly off if we don't fix it.
                    // Let's fix it properly.
                    if (lastChoice.lang === 'en') {
                        enDur -= this.estimateDuration(lastChoice.text || ''); // rough check
                        frDur += this.estimateDuration(lastChoice.altText || '');
                    } else {
                        frDur -= this.estimateDuration(lastChoice.text || '');
                        enDur += this.estimateDuration(lastChoice.altText || '');
                    }
                    outputParas[lastIdx] = lastChoice.altText;
                    enWordsUsed = swapEn;
                    frWordsUsed = swapFr;
                }
            }
        }

        return {
            text: outputParas.join('\n\n***\n\n'),
            enWords: enWordsUsed,
            frWords: frWordsUsed,
            enDur,
            frDur
        };
    }

    // Presentation mode: build slides instead of a flowing speech.
    // slideMode: "single" (entire slide in one language) or "mixed" (half one language, half the other).
    // mixedPattern: "alternating" (default) or "repeating".
    mergePresentation(englishText, frenchText, options) {
        const enSlides = this.parseSlides(englishText);
        const frSlides = this.parseSlides(frenchText);
        const totalSlides = Math.max(enSlides.length, frSlides.length);
        const other = (lang) => lang === 'en' ? 'fr' : 'en';

        if (options.slideMode === 'single') {
            let enWordsUsed = 0;
            let frWordsUsed = 0;
            let enDur = 0;
            let frDur = 0;
            const slidesOut = [];
            for (let i = 0; i < totalSlides; i++) {
                const enSlide = enSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
                const frSlide = frSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
                const totalParas = Math.max(enSlide.paragraphs.length, frSlide.paragraphs.length);
                if (totalParas === 0) continue;

                const startLang = i % 2 === 0 ? options.startLang : other(options.startLang);
                const otherLang = other(startLang);
                const startSlide = startLang === 'en' ? enSlide : frSlide;
                const otherSlide = startLang === 'en' ? frSlide : enSlide;
                const title = startSlide.title || otherSlide.title || `# Slide ${i + 1}`;

                let chosenLang = startSlide.words > 0 ? startLang : otherLang;
                let chosenSlide = startSlide.words > 0 ? startSlide : otherSlide;

                // On the final slide, allow swapping to improve the overall balance.
                if (i === totalSlides - 1 && otherSlide.words > 0) {
                    const currentGap = Math.abs((enWordsUsed + (chosenLang === 'en' ? chosenSlide.words : 0)) - (frWordsUsed + (chosenLang === 'fr' ? chosenSlide.words : 0)));
                    const altLang = chosenLang === 'en' ? 'fr' : 'en';
                    const altSlide = chosenLang === startLang ? otherSlide : startSlide;
                    const altGap = Math.abs((enWordsUsed + (altLang === 'en' ? altSlide.words : 0)) - (frWordsUsed + (altLang === 'fr' ? altSlide.words : 0)));
                    if (altGap < currentGap) {
                        chosenLang = altLang;
                        chosenSlide = altSlide;
                    }
                }

                slidesOut.push({ text: `${title}\n${chosenSlide.body}`.trim() });
                if (chosenLang === 'en') {
                    enWordsUsed += chosenSlide.words;
                    // Only calculate duration ONCE using the full text (Title + Body)
                    enDur += this.estimateDuration(`${title}\n${chosenSlide.body}`);
                } else {
                    frWordsUsed += chosenSlide.words;
                    frDur += this.estimateDuration(`${title}\n${chosenSlide.body}`);
                }
            }

            return {
                text: slidesOut.map(s => s.text).join('\n\n---\n\n'),
                enWords: enWordsUsed,
                frWords: frWordsUsed,
                enDur,
                frDur
            };
        }

        // Mixed mode: start with a 50/50 split, then iteratively slide boundaries to minimize the EN/FR duration gap.
        const slidesMeta = [];
        for (let i = 0; i < totalSlides; i++) {
            const enSlide = enSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
            const frSlide = frSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
            const totalParas = Math.max(enSlide.paragraphs.length, frSlide.paragraphs.length);
            if (totalParas === 0) continue;

            slidesMeta.push({
                index: i,
                enSlide,
                frSlide,
                enParas: enSlide.paragraphs.map(text => ({ text, words: this.countWords(text) })),
                frParas: frSlide.paragraphs.map(text => ({ text, words: this.countWords(text) })),
                totalParas,
                defaultCut: totalParas <= 1 ? 1 : Math.ceil(totalParas / 2),
                fallbackTitle: `# Slide ${i + 1}`
            });
        }

        const buildPlan = (cutsArr) => {
            const slidesOut = [];
            let enWords = 0;
            let frWords = 0;
            let enDur = 0;
            let frDur = 0;
            let lastEndLang = options.startLang;

            for (const meta of slidesMeta) {
                let startLang;
                if (options.mixedPattern === 'repeating') {
                    startLang = options.startLang;
                } else {
                    startLang = slidesOut.length === 0 ? options.startLang : lastEndLang;
                }
                const otherLang = other(startLang);
                const rawCut = Array.isArray(cutsArr) ? cutsArr[meta.index] : undefined;
                const cut = meta.totalParas <= 1
                    ? 1
                    : Math.max(1, Math.min(meta.totalParas - 1, rawCut ?? meta.defaultCut));

                const paraOrder = [];
                let slideEn = 0;
                let slideFr = 0;

                for (let idx = 0; idx < meta.totalParas; idx++) {
                    const plannedLang = idx < cut ? startLang : otherLang;
                    const primary = plannedLang === 'en' ? (meta.enParas[idx] || { text: '', words: 0 }) : (meta.frParas[idx] || { text: '', words: 0 });
                    const fallback = plannedLang === 'en' ? (meta.frParas[idx] || { text: '', words: 0 }) : (meta.enParas[idx] || { text: '', words: 0 });
                    const chosen = primary.text ? primary : fallback;
                    if (!chosen.text) continue;
                    const chosenLang = primary.text ? plannedLang : other(plannedLang);
                    paraOrder.push({ text: chosen.text, lang: chosenLang, words: chosen.words });
                    if (chosenLang === 'en') {
                        slideEn += chosen.words;
                        enDur += this.estimateDuration(chosen.text);
                    } else {
                        slideFr += chosen.words;
                        frDur += this.estimateDuration(chosen.text);
                    }
                }

                // Enforce bilingual content per slide by appending the missing language when possible.
                const langsUsed = new Set(paraOrder.map(p => p.lang));
                if (paraOrder.length > 0 && langsUsed.size === 1) {
                    const missingLang = langsUsed.has('en') ? 'fr' : 'en';
                    const missingPara = missingLang === 'en'
                        ? (meta.enParas[meta.totalParas - 1] || { text: '', words: 0 })
                        : (meta.frParas[meta.totalParas - 1] || { text: '', words: 0 });
                    if (missingPara.text) {
                        paraOrder.push({ text: missingPara.text, lang: missingLang, words: missingPara.words });
                        if (missingLang === 'en') {
                            slideEn += missingPara.words;
                            enDur += this.estimateDuration(missingPara.text);
                        } else {
                            slideFr += missingPara.words;
                            frDur += this.estimateDuration(missingPara.text);
                        }
                    }
                }

                const endLang = paraOrder.length ? paraOrder[paraOrder.length - 1].lang : startLang;
                const startSlide = startLang === 'en' ? meta.enSlide : meta.frSlide;
                const otherSlide = startLang === 'en' ? meta.frSlide : meta.enSlide;
                const title = startSlide.title || otherSlide.title || meta.fallbackTitle;
                const parts = [title];
                if (paraOrder.length > 0) parts.push(paraOrder.map(p => p.text).join('\n\n'));

                slidesOut.push({ text: parts.join('\n\n').trim(), endLang });
                enWords += slideEn;
                frWords += slideFr;

                // Add title duration to the starting language of the slide
                // (Since we prepend the title, it effectively belongs to the slide context)
                if (startLang === 'en') {
                    enDur += this.estimateDuration(title);
                } else {
                    frDur += this.estimateDuration(title);
                }

                lastEndLang = endLang;
            }

            return { slidesOut, enWords, frWords, enDur, frDur };
        };

        let cuts = Array(totalSlides).fill(undefined);
        slidesMeta.forEach(meta => cuts[meta.index] = meta.defaultCut);

        let plan = buildPlan(cuts);
        let bestDelta = Math.abs(plan.enDur - plan.frDur);
        const maxIterations = Math.max(1, slidesMeta.length * 4);

        for (let iter = 0; iter < maxIterations; iter++) {
            let candidate = null;
            for (const meta of slidesMeta) {
                if (meta.totalParas <= 1) continue;
                const currentCut = cuts[meta.index];
                const optionsCuts = [];
                if (currentCut - 1 >= 1) optionsCuts.push(currentCut - 1);
                if (currentCut + 1 <= meta.totalParas - 1) optionsCuts.push(currentCut + 1);

                for (const newCut of optionsCuts) {
                    if (newCut === currentCut) continue;
                    const testCuts = [...cuts];
                    testCuts[meta.index] = newCut;
                    const testPlan = buildPlan(testCuts);
                    const testDelta = Math.abs(testPlan.enDur - testPlan.frDur);
                    if (!candidate || testDelta < candidate.delta) {
                        candidate = { cuts: testCuts, plan: testPlan, delta: testDelta };
                    }
                }
            }

            if (candidate && candidate.delta + 1e-6 < bestDelta) {
                cuts = candidate.cuts;
                plan = candidate.plan;
                bestDelta = candidate.delta;
            } else {
                break;
            }
        }

        return {
            text: plan.slidesOut.map(s => s.text).join('\n\n---\n\n'),
            enWords: plan.enWords,
            frWords: plan.frWords,
            enDur: plan.enDur,
            frDur: plan.frDur
        };
    }
}
// Practice Mode Controller
class PracticeController {
    constructor() {
        this.overlay = document.getElementById('practice-modal');
        this.prevText = document.getElementById('practice-prev-text');
        this.currentText = document.getElementById('practice-current-text');
        this.nextText = document.getElementById('practice-next-text');
        this.practiceContent = document.getElementById('practice-content');
        this.playBtn = document.getElementById('practice-play-btn');
        this.pauseBtn = document.getElementById('practice-pause-btn');
        this.playIcon = null;
        this.pauseIcon = null;
        this.resetBtn = document.getElementById('practice-reset-btn');
        this.closeBtn = document.getElementById('close-practice-btn');
        this.wpmSlider = document.getElementById('wpm-slider');
        this.wpmDisplay = document.getElementById('wpm-display');
        this.wpmGuidance = document.getElementById('wpm-guidance');
        this.wpmDescription = document.getElementById('wpm-description');
        this.timerTotal = document.getElementById('timer-total');
        this.timerCurrent = document.getElementById('timer-current');
        this.timerRemaining = document.getElementById('timer-remaining');
        this.fontIncreaseBtn = document.getElementById('font-increase-btn');
        this.fontDecreaseBtn = document.getElementById('font-decrease-btn');
        this.isPlaying = false;
        this.isPaused = false;
        this.content = [];
        this.currentIndex = 0;
        this.timer = null;
        this.wpm = parseInt(this.wpmSlider?.value, 10) || 150;
        this.baseDelay = 60000 / this.wpm;
        this.currentWordGlobalIdx = 0;
        this.totalWords = 0;
        this.launchTime = 0;
        this.elapsedPaused = 0;
        this.lastPauseStart = 0;
        this.fontSize = 300;
        this.t = {}; // Translations
        this.bindEvents();
    }
    setTranslations(t) {
        this.t = t;
        this.updateSpeedDisplay(); // Re-render guidance with new lang
    }

    bindEvents() {
        if (this.playBtn) this.playBtn.addEventListener('click', () => this.start());
        if (this.pauseBtn) this.pauseBtn.addEventListener('click', () => this.pause());
        if (this.resetBtn) this.resetBtn.addEventListener('click', () => this.reset());
        if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
        if (this.wpmSlider) {
            this.wpmSlider.addEventListener('input', () => {
                this.wpm = Math.max(50, Math.min(600, parseInt(this.wpmSlider.value, 10) || 150));
                this.baseDelay = 60000 / this.wpm;
                this.updateSpeedDisplay();
                this.updateTotalDuration();
            });
        }
        if (this.fontIncreaseBtn) this.fontIncreaseBtn.addEventListener('click', () => this.changeFontSize(10));
        if (this.fontDecreaseBtn) this.fontDecreaseBtn.addEventListener('click', () => this.changeFontSize(-10));
        document.addEventListener('keydown', (e) => {
            if (!this.overlay || !this.overlay.classList.contains('active')) return;
            if (e.code === 'Space') {
                e.preventDefault();
                this.togglePlay();
            } else if (e.code === 'Escape') {
                this.close();
            }
        });
    }
    openFromMerged(mergedText) {
        // Clean text: remove slide delimiters like *** or --
        let cleanedText = mergedText.replace(/[*]{3,}|[-]{3,}/g, ' ').replace(/\s+/g, ' ');

        // Attach quotes to words (remove spaces inside quotes)
        // French guillemets: « word » -> «word»
        // Update: User requested keeping spaces but treating as one word.
        // So we do NOT remove spaces.
        // cleanedText = cleanedText.replace(/«\s+/g, '«').replace(/\s+»/g, '»');
        // English quotes: " word " -> "word" (simplified: remove space after opening " and before closing " if possible, 
        // but " is ambiguous. Start with French as it's the main request causing "word" vs " " issues).
        // For simple " matching, we can try to collapse " \w and \w " but " is context dependent.
        // Robust generic approach: remove spaces around punctuation that should appear attached?
        // User specifically asked for " and << or >>.
        cleanedText = cleanedText.replace(/"\s+([^"]*?)\s+"/g, '"$1"'); // Try to clean paired quotes if possible, else rely on simple trim

        // Split by sentence delimiters (. ! ?) but keep them attached
        const sentences = cleanedText.replace(/([.!?])\s+/g, '$1|').split('|');

        this.content = sentences.map(text => {
            const trimmed = text.trim();
            if (!trimmed) return null;
            return {
                text: trimmed,
                lang: 'mix', // Language detection logic could go here
                // Use the same regex as countWords to group French quotes
                words: trimmed.match(/«[^»]+»|\S+/g) || []
            };
        }).filter(Boolean);

        if (!this.overlay || this.content.length === 0) return;
        this.totalWords = this.content.reduce((acc, sent) => acc + sent.words.length, 0);
        this.overlay.classList.add('active');
        this.overlay.style.display = 'block';
        this.overlay.setAttribute('aria-hidden', 'false');
        this.reset();
        this.updateTotalDuration();
        this.applyFontSize();
    }

    // ... close, reset, togglePlay, start, pause, stop, updatePlayButton, adjustSpeed, updateSpeedDisplay, changeFontSize, applyFontSize, runCountdown, prepareContent ...

    tick() {
        if (!this.isPlaying) return;
        if (this.currentIndex >= this.content.length) {
            this.stop();
            return;
        }

        // Calculate timing
        const currentSentence = this.content[this.currentIndex];
        const sentenceWords = currentSentence.words;
        const totalSentenceWords = sentenceWords.length;

        if (typeof this.currentSentenceWordIdx === 'undefined') {
            this.currentSentenceWordIdx = 0;
        }

        this.updateThreeSentences();
        this.updateRunningTimers();

        // Check if we finished the sentence
        if (this.currentSentenceWordIdx >= totalSentenceWords) {
            // Calculate pause duration based on punctuation of the FINISHED sentence
            let pause = 0;
            const lastChar = currentSentence.text.slice(-1);
            if ('.!?'.includes(lastChar)) pause = this.baseDelay * 2.0; // 2x word length pause
            else if (',;:'.includes(lastChar)) pause = this.baseDelay * 1.0;

            // Advance to next sentence IMMEDIATELY so user can see it during the pause
            this.currentIndex++;
            this.currentSentenceWordIdx = -1; // -1 indicates "before first word" state

            if (this.currentIndex >= this.content.length) {
                this.stop(); // End of session
                return;
            }

            this.updateThreeSentences(); // Update view to show new sentence
            this.updateRunningTimers();

            // Wait for the pause, then start highlighting the new sentence
            this.timer = setTimeout(() => {
                this.currentSentenceWordIdx = 0; // Ready for first word
                this.tick();
            }, pause);
        } else {
            // Move to next word
            // Check if current word (the one we just displayed/processed) ends in mid-sentence punctuation
            // Note: currentSentenceWordIdx points to the word we are currently on.
            // When we move to next, we are finishing the current word.
            let delay = this.baseDelay;
            const currentWord = sentenceWords[this.currentSentenceWordIdx];
            if (currentWord) {
                if (',;:'.includes(currentWord.slice(-1))) {
                    delay += this.baseDelay; // Add 1x pause
                }
                if (currentWord === '#') {
                    delay += this.baseDelay * 2.0; // Add 2x pause
                }
            }

            this.timer = setTimeout(() => {
                this.currentSentenceWordIdx++;
                this.currentWordGlobalIdx++;
                this.tick();
            }, delay);
        }
    }
    close() {
        this.stop();
        if (this.overlay) {
            this.overlay.classList.remove('active');
            this.overlay.style.display = 'none';
            this.overlay.setAttribute('aria-hidden', 'true');
        }
    }
    reset() {
        this.stop();
        this.currentIndex = 0;
        this.currentWordGlobalIdx = 0;
        this.currentSentenceWordIdx = 0; // Initialize for immediate display
        this.isPaused = false;
        this.isPlaying = false;
        this.updatePlayButton();
        this.updateThreeSentences();
        this.updateSpeedDisplay();
        if (this.timerCurrent) this.timerCurrent.textContent = '00:00';
        if (this.timerRemaining && this.timerTotal) this.timerRemaining.textContent = this.timerTotal.textContent;
    }
    togglePlay() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.start();
        }
    }
    start() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.isPaused = false;
        this.updatePlayButton();
        if (this.currentIndex === 0 && this.currentWordGlobalIdx === 0) {
            this.runCountdown().then(() => {
                if (!this.isPlaying) return;
                this.launchTime = Date.now();
                this.elapsedPaused = 0;
                this.tick();
            });
        } else {
            if (this.lastPauseStart) {
                this.elapsedPaused += (Date.now() - this.lastPauseStart);
                this.lastPauseStart = 0;
            }
            this.tick();
        }
    }
    pause() {
        this.isPlaying = false;
        this.isPaused = true;
        this.lastPauseStart = Date.now();
        if (this.timer) clearTimeout(this.timer);
        this.updatePlayButton();
    }
    stop() {
        this.isPlaying = false;
        this.isPaused = false;
        if (this.timer) clearTimeout(this.timer);
        this.updatePlayButton();
    }
    updatePlayButton() {
        if (this.playBtn) this.playBtn.style.display = this.isPlaying ? 'none' : 'inline-flex';
        if (this.pauseBtn) this.pauseBtn.style.display = this.isPlaying ? 'inline-flex' : 'none';
    }
    adjustSpeed(delta) {
        this.wpm = Math.max(50, Math.min(600, this.wpm + delta));
        this.baseDelay = 60000 / this.wpm;
        this.updateSpeedDisplay();
        this.updateTotalDuration();
    }
    updateSpeedDisplay() {
        if (this.wpmDisplay) this.wpmDisplay.textContent = `${this.wpm} WPM`;
        if (this.wpmGuidance) {
            if (this.wpm < 110) this.wpmGuidance.textContent = this.t.practiceSpeedSlow || 'Slow pace';
            else if (this.wpm > 180) this.wpmGuidance.textContent = this.t.practiceSpeedFast || 'Fast pace';
            else this.wpmGuidance.textContent = this.t.practiceSpeedNormal || 'Normal pace';
        }
    }
    changeFontSize(delta) {
        this.fontSize = Math.max(100, Math.min(500, this.fontSize + delta));
        this.applyFontSize();
    }
    applyFontSize() {
        const secondarySize = Math.max(60, Math.round(this.fontSize * 0.67));
        if (this.prevText) this.prevText.style.fontSize = `${secondarySize}%`;
        if (this.currentText) this.currentText.style.fontSize = `${this.fontSize}%`;
        if (this.nextText) this.nextText.style.fontSize = `${secondarySize}%`;
        if (this.practiceContent) this.practiceContent.style.fontSize = `${this.fontSize}%`;
    }
    runCountdown() {
        // Ensure text is visible for preparation
        this.updateThreeSentences();

        const overlay = document.getElementById('countdown-overlay');
        const number = document.getElementById('countdown-number');

        if (!overlay || !number) return Promise.resolve();

        return new Promise(resolve => {
            overlay.style.display = 'flex';
            let count = 3;
            number.textContent = count;
            // Indigo color is handled by CSS var(--primary-color) usually, ensuring styling matches

            const int = setInterval(() => {
                count--;
                if (count > 0) {
                    number.textContent = count;
                } else {
                    clearInterval(int);
                    overlay.style.display = 'none';
                    resolve();
                }
            }, 1000);
        });
    }
    prepareContent(en, fr) {
        // French quote handling integration
        const process = (t) => t.replace(/«\s*/g, '«').replace(/\s*»/g, '»');
        const merge = (text, lang) => {
            const processed = process(text);
            return processed.replace(/([.!?])\s+/g, '$1|').split('|').filter(s => s.trim()).map(s => ({ text: s.trim(), lang }));
        };
        const enS = merge(en, 'en');
        const frS = merge(fr, 'fr');
        const combined = [];
        const max = Math.max(enS.length, frS.length);
        for (let i = 0; i < max; i++) {
            if (enS[i]) combined.push({ ...enS[i], words: enS[i].text.split(/\s+/) });
            if (frS[i]) combined.push({ ...frS[i], words: frS[i].text.split(/\s+/) });
        }
        return combined;
    }

    updateThreeSentences() {
        const prev = this.content[this.currentIndex - 1];
        const curr = this.content[this.currentIndex];
        const next = this.content[this.currentIndex + 1];

        if (this.prevText) {
            this.prevText.innerHTML = prev ? prev.text : '&nbsp;';
            this.prevText.className = prev ? `practice-sentence prev ${prev.lang}` : 'practice-sentence prev';
        }

        if (this.currentText) {
            // Apply highlighting to the current sentence
            this.currentText.innerHTML = curr ? this.highlight(curr, this.currentSentenceWordIdx) : (this.t.endOfSession || 'End of session');
            this.currentText.className = curr ? `practice-sentence active ${curr.lang}` : 'practice-sentence active';
        }

        if (this.nextText) {
            this.nextText.innerHTML = next ? next.text : '&nbsp;';
            this.nextText.className = next ? `practice-sentence next ${next.lang}` : 'practice-sentence next';
        }

        if (this.practiceContent) {
            this.practiceContent.style.display = 'none';
        }
    }

    highlight(sent, activeWordIndex) {
        if (!sent || !sent.words) return '';
        return sent.words.map((word, idx) => {
            // Highlight current word
            if (idx === activeWordIndex) {
                return `<span class="practice-word active">${word}</span>`;
            }
            // Words already spoken
            else if (idx < activeWordIndex) {
                return `<span class="practice-word spoken">${word}</span>`;
            }
            // Future words
            return `<span class="practice-word">${word}</span>`;
        }).join(' ');
    }
    calculateTotalDuration() {
        if (!this.content.length) return 0;
        let totalMs = 0;
        const wordMs = this.baseDelay;
        for (const sent of this.content) {
            // Words duration
            totalMs += sent.words.length * wordMs;

            // Mid-sentence pauses (1x)
            for (const word of sent.words) {
                if (',;:'.includes(word.slice(-1))) {
                    totalMs += wordMs;
                }
                if (word === '#') {
                    totalMs += wordMs * 2.0;
                }
            }

            // Punctuation pause duration (2x)
            const lastChar = sent.text.slice(-1);
            if ('.!?'.includes(lastChar)) totalMs += wordMs * 2.0;
        }
        return totalMs;
    }
    updateTotalDuration() {
        const ms = this.calculateTotalDuration();
        const sec = Math.ceil(ms / 1000);
        const min = Math.floor(sec / 60);
        const s = sec % 60;
        if (this.timerTotal) this.timerTotal.textContent = `${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    updateRunningTimers() {
        const ms = (this.currentWordGlobalIdx * this.baseDelay);
        const sec = Math.floor(ms / 1000);
        const min = Math.floor(sec / 60);
        const s = sec % 60;
        if (this.timerCurrent) this.timerCurrent.textContent = `${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const totalMs = this.calculateTotalDuration();
        const remMs = Math.max(0, totalMs - ms);
        const rSec = Math.ceil(remMs / 1000);
        const rMin = Math.floor(rSec / 60);
        const rS = rSec % 60;
        if (this.timerRemaining) this.timerRemaining.textContent = `${String(rMin).padStart(2, '0')}:${String(rS).padStart(2, '0')}`;
    }
}

class SessionManager {
    constructor() {
        this.STORAGE_KEY = 'text_bilingual_sessions';

        // UI Elements
        this.saveBtn = document.getElementById('save-session-btn');
        this.loadBtn = document.getElementById('load-session-btn');
        this.saveModal = document.getElementById('save-modal');
        this.loadModal = document.getElementById('load-modal');
        this.closeSaveBtn = document.getElementById('close-save-btn');
        this.closeLoadBtn = document.getElementById('close-load-btn');
        this.cancelSaveBtn = document.getElementById('cancel-save-btn');
        this.confirmSaveBtn = document.getElementById('confirm-save-btn');
        this.sessionNameInput = document.getElementById('session-name-input');
        this.sessionList = document.getElementById('session-list');

        this.bindEvents();
    }

    bindEvents() {
        if (this.saveBtn) this.saveBtn.addEventListener('click', () => this.openSaveModal());
        if (this.loadBtn) this.loadBtn.addEventListener('click', () => this.openLoadModal());
        if (this.closeSaveBtn) this.closeSaveBtn.addEventListener('click', () => this.closeSaveModal());
        if (this.closeLoadBtn) this.closeLoadBtn.addEventListener('click', () => this.closeLoadModal());
        if (this.cancelSaveBtn) this.cancelSaveBtn.addEventListener('click', () => this.closeSaveModal());
        if (this.confirmSaveBtn) this.confirmSaveBtn.addEventListener('click', () => this.saveCurrentSession());

        // Close on outside click
        window.addEventListener('click', (e) => {
            if (this.saveModal && e.target === this.saveModal) this.closeSaveModal();
            if (this.loadModal && e.target === this.loadModal) this.closeLoadModal();
        });

        // Enter key on input
        if (this.sessionNameInput) {
            this.sessionNameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.saveCurrentSession();
                if (e.key === 'Escape') this.closeSaveModal();
            });
        }
    }

    getSessions() {
        try {
            return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
        } catch (e) {
            console.error('Error reading sessions', e);
            return {};
        }
    }

    saveSessionFull(name, data) {
        const sessions = this.getSessions();
        sessions[name] = {
            ...data,
            timestamp: Date.now()
        };
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(sessions));
    }

    deleteSession(name) {
        const sessions = this.getSessions();
        delete sessions[name];
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(sessions));
        this.renderSessionList();
    }

    openSaveModal() {
        this.sessionNameInput.value = '';
        this.saveModal.style.display = 'block';
        this.saveModal.setAttribute('aria-hidden', 'false');
        this.sessionNameInput.focus();
    }

    closeSaveModal() {
        this.saveModal.style.display = 'none';
        this.saveModal.setAttribute('aria-hidden', 'true');
    }

    saveCurrentSession() {
        const name = this.sessionNameInput.value.trim();
        if (!name) {
            alert('Please enter a session name');
            return;
        }

        // Gather State
        const data = {
            englishText: document.getElementById('english-text').value,
            frenchText: document.getElementById('french-text').value,
            mode: document.querySelector('input[name="mode"]:checked')?.value,
            startLang: document.querySelector('input[name="start-lang"]:checked')?.value,
            slideMode: document.querySelector('input[name="slide-mode"]:checked')?.value,
            mixedPattern: document.querySelector('input[name="mixed-pattern"]:checked')?.value,
            durationMode: document.querySelector('input[name="duration-mode"]:checked')?.value,
            blockTime: document.getElementById('block-time').value,
            isOutputVisible: document.getElementById('output-section').style.display !== 'none'
        };

        this.saveSessionFull(name, data);
        this.closeSaveModal();

        // Show brief confirmation
        const validationMsg = document.getElementById('validation-message');
        if (validationMsg) {
            validationMsg.textContent = `Session "${name}" saved!`;
            validationMsg.style.display = 'block';
            validationMsg.style.backgroundColor = '#ecfccb'; // light green
            validationMsg.style.borderColor = '#bef264';
            validationMsg.style.color = '#3f6212';
            setTimeout(() => {
                validationMsg.style.display = 'none';
            }, 3000);
        }
    }

    openLoadModal() {
        this.renderSessionList();
        this.loadModal.style.display = 'block';
        this.loadModal.setAttribute('aria-hidden', 'false');
    }

    closeLoadModal() {
        this.loadModal.style.display = 'none';
        this.loadModal.setAttribute('aria-hidden', 'true');
    }

    renderSessionList() {
        const sessions = this.getSessions();
        const names = Object.keys(sessions).sort((a, b) => sessions[b].timestamp - sessions[a].timestamp);

        this.sessionList.innerHTML = '';

        if (names.length === 0) {
            this.sessionList.innerHTML = '<p class="empty-state">No saved sessions found.</p>';
            return;
        }

        names.forEach(name => {
            const date = new Date(sessions[name].timestamp).toLocaleString();
            const el = document.createElement('div');
            el.className = 'session-item';
            el.innerHTML = `
                <div class="session-info" role="button" tabindex="0">
                    <div class="session-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                    </div>
                    <div class="session-details">
                        <span class="session-name">${this.escapeHtml(name)}</span>
                        <span class="session-date">${date}</span>
                    </div>
                </div>
                <button class="session-delete" aria-label="Delete session">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            `;

            // Bind Load
            el.querySelector('.session-info').addEventListener('click', () => this.loadSession(name));
            el.querySelector('.session-info').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') this.loadSession(name);
            });

            // Bind Delete
            el.querySelector('.session-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Delete session "${name}"?`)) {
                    this.deleteSession(name);
                }
            });

            this.sessionList.appendChild(el);
        });
    }

    loadSession(name) {
        const sessions = this.getSessions();
        const data = sessions[name];
        if (!data) return;

        // Apply State
        if (data.englishText !== undefined) document.getElementById('english-text').value = data.englishText;
        if (data.frenchText !== undefined) document.getElementById('french-text').value = data.frenchText;

        this.setRadio('mode', data.mode);
        this.setRadio('start-lang', data.startLang);
        this.setRadio('slide-mode', data.slideMode);
        this.setRadio('mixed-pattern', data.mixedPattern);
        this.setRadio('duration-mode', data.durationMode);

        if (data.blockTime) {
            const slider = document.getElementById('block-time');
            if (slider) {
                slider.value = data.blockTime;
                slider.dispatchEvent(new Event('input'));
            }
        }

        // Trigger change events to update UI visibility
        ['mode', 'start-lang', 'slide-mode', 'mixed-pattern', 'duration-mode'].forEach(group => {
            const checked = document.querySelector(`input[name="${group}"]:checked`);
            if (checked) checked.dispatchEvent(new Event('change'));
        });

        // Trigger input event on textareas
        const enInput = document.getElementById('english-text');
        const frInput = document.getElementById('french-text');
        if (enInput) enInput.dispatchEvent(new Event('input'));
        if (frInput) frInput.dispatchEvent(new Event('input'));

        this.closeLoadModal();

        // Restore Output if it was visible
        if (data.isOutputVisible) {
            const generateBtn = document.getElementById('generate-btn');
            if (generateBtn) {
                // Use setTimeout to allow UI updates/events to propagate first if needed
                setTimeout(() => generateBtn.click(), 50);
            }
        }

        // Show confirmation
        const validationMsg = document.getElementById('validation-message');
        if (validationMsg) {
            validationMsg.textContent = `Session "${name}" loaded!`;
            validationMsg.style.display = 'block';
            validationMsg.style.backgroundColor = '#e0f2fe';
            validationMsg.style.borderColor = '#7dd3fc';
            validationMsg.style.color = '#0369a1';
            setTimeout(() => {
                validationMsg.style.display = 'none';
            }, 3000);
        }
    }

    setRadio(name, value) {
        if (!value) return;
        const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
        if (radio) radio.checked = true;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const merger = new BilingualMerger();
    const practiceMode = new PracticeController();
    const sessionManager = new SessionManager();
    // DOM Elements
    const enInput = document.getElementById('english-text');
    const frInput = document.getElementById('french-text');
    const enCountDisplay = document.getElementById('en-count');
    const frCountDisplay = document.getElementById('fr-count');
    const generateBtn = document.getElementById('generate-btn');
    const outputSection = document.getElementById('output-section');
    const outputPreview = document.getElementById('output-preview');
    const blockTimeInput = document.getElementById('block-time');
    const blockTimeDisplay = document.getElementById('block-time-display');
    const copyBtn = document.getElementById('copy-btn');
    const downloadBtn = document.getElementById('download-btn');
    const manualControls = document.getElementById('manual-controls');
    const optimalControls = document.getElementById('optimal-controls');
    const optimalResultEl = document.getElementById('optimal-result');
    const durationRadios = document.querySelectorAll('input[name="duration-mode"]');
    const slideRadios = document.querySelectorAll('input[name="slide-mode"]');
    const statsDiv = document.getElementById('result-stats');
    const presentationSettings = document.getElementById('presentation-settings');
    const mixedPatternSettings = document.getElementById('mixed-pattern-settings');
    const themeToggleBtn = document.getElementById('theme-toggle');
    const themeIcon = document.getElementById('theme-icon');
    const expandButtons = document.querySelectorAll('.expand-btn');
    const langToggleBtn = document.getElementById('lang-toggle');
    const loadSpeechExampleBtn = document.getElementById('load-speech-example');
    const loadPresentationExampleBtn = document.getElementById('load-presentation-example');
    const resetBtn = document.getElementById('reset-btn');
    const formatTextBtn = document.getElementById('format-text-btn');
    const formatTooltipIcon = document.getElementById('format-tooltip');
    const durationTooltip = document.getElementById('duration-tooltip');
    const optimalBandsTooltip = document.getElementById('optimal-bands-tooltip');
    const practiceBtn = document.getElementById('practice-btn');
    let currentLang = 'en';
    let lastOptimal = null;
    let lastGenParams = null;
    const translations = {
        en: {
            appTitle: 'Bilingual Text Generator',
            subtitle: 'Deliver a balanced bilingual speech or presentation, alternating between the full English and French versions provided',
            stepInputTitle: 'Enter Text',
            stepSettingsTitle: 'Configure & Generate',
            englishLabel: 'English Version (speech or speaking notes)',
            frenchLabel: 'French Version (speech or speaking notes)',
            englishPlaceholder: 'Paste English text here...',
            frenchPlaceholder: 'Paste French text here...',
            formatTitle: 'Formatting Tips',
            formatGeneral: '<strong>General:</strong> Ensure both versions have the same number of paragraphs.',
            formatSpeech: '<strong>Speech:</strong> Keep paragraph order identical in both languages.',
            formatPresentation: '<strong>Presentation:</strong> Start slides with "#" (e.g., "# Slide 1"). Match paragraphs under each slide.',
            loadSpeech: 'Load Speech Example',
            loadPresentation: 'Load Presentation Example',
            reset: 'Clear / Reset',
            settings: 'Settings',
            mode: 'Mode',
            speech: 'Speech',
            presentation: 'Presentation',
            modeTip: 'Speech: time-based blocks.\nPresentation: slide-by-slide output.',
            startingLanguage: 'Starting Language',
            english: 'English',
            french: 'French',
            slideMode: 'Slide Language Mode',
            single: 'Single',
            mixed: 'Mixed',
            mixedModePattern: 'Mixed Mode Pattern',
            mixedModePatternTooltip: 'Alternating: Slide 1 (A-B), Slide 2 (B-A).\nRepeating: Slide 1 (A-B), Slide 2 (A-B).',
            alternating: 'Alternating',
            repeating: 'Repeating',
            slideTip: 'Single: one language per slide.\nMixed: both languages on every slide.',
            blockTime: 'Language Duration',
            blockHint: 'Time before switching languages.',
            durationOptimal: 'Optimal',
            durationManual: 'Manual',
            durationTooltip: 'Length of time you speak in one language before switching. Choose Optimal to auto-balance or Manual to set it yourself.',
            optimalResult: (avgWords, minTime, maxTime, bestTime) => `Based on average length of ${avgWords} words:\n- Recommended: ${minTime}-${maxTime}s\n- Optimal found: ${bestTime}s`,
            optimalResultPlaceholder: '',
            optimalLabel: 'Optimal',
            bestLabel: 'Best',
            optimalBandsTooltip: `Suggested blocks:\nSpeech time: 0-5 min | Block: 15-30s\nSpeech time: 5-10 min | Block: 30-60s\nSpeech time: 10-20 min | Block: 45-90s\nSpeech time: 20+ min | Block: 60-120s`,
            generate: 'Generate Bilingual Text',
            outputTitle: 'Bilingual Speech',
            copy: 'Copy to Clipboard',
            download: 'Download .md',
            statsEnglish: 'English',
            statsFrench: 'French',
            statsTotal: 'Total',
            words: 'words',
            formatButton: 'Format Text',
            formatTooltip: 'Optional: Tries to clean up and format your raw text for you.',
            minAbbr: 'min',
            secAbbr: 'sec',
            validationMissing: 'Please enter text for both languages.',
            validationNoSlides: 'No slides found. Please start slide lines with "#".',
            validationNoEnSlides: 'No slides found in English text. Use "#" for slides.',
            validationNoFrSlides: 'No slides found in French text. Use "#" for slides.',
            validationSlides: (enCount, frCount) => `Slide count mismatch: English has ${enCount}, French has ${frCount}. Check your "#" headings.`,
            validationParagraphs: (enCount, frCount) => `Paragraph count mismatch: English has ${enCount}, French has ${frCount}. Please align them.`,
            modeSummarySpeech: (start, block, words, optimal) => `Speech | Start: ${start} | Switch every: ${block}s (~${words} words)${optimal ? ` | Optimal: ${optimal}s` : ''}`,
            modeSummaryPresentation: (start, slideMode) => `Presentation | Start: ${start} | Mode: ${slideMode}`,
            exampleLoadedPresentation: 'Presentation example loaded.',
            exampleLoadedSpeech: 'Speech example loaded.',
            exampleLoadError: 'Could not load examples.',
            copySuccess: 'Copied!',
            expandEn: 'Expand English text',
            expandFr: 'Expand French text',
            textFormatted: 'Text formatted!',
            descTitle: 'What it does',
            descContent: 'This tool helps you create a bilingual version of a speech or speaking notes. It mixes your English and French text into one script, with each language taking about half of the time. The tool picks good places to switch between languages and sets the right amount of time to stay in one language before switching.',
            // Additions
            liveMode: 'Live Mode',
            themeToggleAriaLabel: 'Toggle theme',
            langToggleAriaLabel: 'Toggle interface language',
            footerLicensePrefix: 'Content on this site is licensed under',
            footerLicenseLink: 'CC BY-NC 4.0',
            footerSourcePrefix: '; please credit the source for any non-commercial use. The source code is available on',
            footerSourceLink: 'GitHub',
            footerRights: 'Aaron Percival. All rights reserved.',
            practiceTitle: 'Live Mode',
            practiceDecreaseFont: 'Decrease font size',
            practiceIncreaseFont: 'Increase font size',
            practiceClose: 'Close practice mode',
            practiceSpeed: 'Speed:',
            practiceSpeedSlow: 'Slow',
            practiceSpeedFast: 'Fast',
            practiceSpeedNormal: 'Normal pace',
            practiceLabelSlow: 'Slow (100)',
            practiceLabelFast: 'Fast (180+)',
            practiceDescription: 'Normal pace (130-160 WPM): Common for public speaking. Balances information and engagement.',
            practicePlay: 'Play',
            practicePause: 'Pause',
            practiceReset: 'Reset',
            practiceCurrent: 'Current',
            practiceRemaining: 'Remaining',
            practiceTotal: 'Total',
            endOfSession: 'End of session'
        },
        fr: {
            appTitle: 'G\u00e9n\u00e9rateur de texte bilingue',
            subtitle: 'Prononcez un discours ou faites une pr\u00e9sentation bilingue \u00e9quilibr\u00e9e, en alternant les versions compl\u00e8tes en anglais et en fran\u00e7ais fournies',
            stepInputTitle: 'Saisir le texte',
            stepSettingsTitle: 'Configurer et g\u00e9n\u00e9rer',
            englishLabel: 'Version anglaise (discours ou notes d\'allocution)',
            frenchLabel: 'Version fran\u00e7aise (discours ou notes d\'allocution)',
            englishPlaceholder: 'Collez le texte anglais ici...',
            frenchPlaceholder: 'Collez le texte fran\u00e7ais ici...',
            formatTitle: 'Conseils de formatage',
            formatGeneral: '<strong>G\u00e9n\u00e9ral :</strong> Assurez-vous que les deux versions ont le m\u00eame nombre de paragraphes.',
            formatSpeech: '<strong>Discours :</strong> Gardez le m\u00eame ordre de paragraphes dans chaque langue.',
            formatPresentation: '<strong>Pr\u00e9sentation :</strong> Commencez chaque diapo par \"#\" (ex. \"# Diapo 1\"). Alignez les paragraphes sous chaque diapo.',
            loadSpeech: 'Exemple de discours',
            loadPresentation: 'Exemple de pr\u00e9sentation',
            reset: 'Effacer / R\u00e9initialiser',
            settings: 'Param\u00e8tres',
            mode: 'Mode',
            speech: 'Discours',
            presentation: 'Pr\u00e9sentation',
            modeTip: 'Discours : blocs bas\u00e9s sur le temps.\nPr\u00e9sentation : sortie diapo par diapo.',
            startingLanguage: 'Langue de d\u00e9part',
            english: 'Anglais',
            french: 'Fran\u00e7ais',
            slideMode: 'Mode diapositives',
            single: 'Unique',
            mixed: 'Mixte',
            mixedModePattern: 'Modèle de mode mixte',
            mixedModePatternTooltip: 'Alterné : Diapo 1 (A-B), Diapo 2 (B-A).\nRépété : Diapo 1 (A-B), Diapo 2 (A-B).',
            alternating: 'Alterné',
            repeating: 'Répété',
            slideTip: 'Unique : une langue par diapo.\nMixte : les deux langues sur chaque diapo.',
            blockTime: 'Dur\u00e9e par langue',
            blockHint: 'Temps avant de changer de langue.',
            durationOptimal: 'Optimal',
            durationManual: 'Manuel',
            durationTooltip: 'Temps pendant lequel vous parlez dans une langue avant de changer. Choisissez Optimal pour un \u00e9quilibre automatique ou Manuel pour fixer vous-m\u00eame.',
            optimalResult: (avgWords, minTime, maxTime, bestTime) => `Bas\u00e9 sur une longueur moyenne de ${avgWords} mots :\n- Dur\u00e9e conseill\u00e9e : ${minTime}-${maxTime}s\n- Optimal trouv\u00e9 : ${bestTime}s`,
            optimalResultPlaceholder: '',
            optimalLabel: 'Optimal',
            bestLabel: 'Meilleur',
            optimalBandsTooltip: `Blocs sugg\u00e9r\u00e9s :\nTemps de discours : 0-5 min | Bloc: 15-30s\nTemps de discours : 5-10 min | Bloc: 30-60s\nTemps de discours : 10-20 min | Block: 45-90s\nTemps de discours : 20+ min | Block: 60-120s`,
            generate: 'G\u00e9n\u00e9rer le texte bilingue',
            outputTitle: 'Texte bilingue',
            copy: 'Copier',
            download: 'T\u00e9l\u00e9charger .md',
            statsEnglish: 'Anglais',
            statsFrench: 'Fran\u00e7ais',
            statsTotal: 'Total',
            words: 'mots',
            formatButton: 'Formater le texte',
            formatTooltip: 'Optionnel : Tente de nettoyer et de bien formater votre texte brut.',
            minAbbr: 'min',
            secAbbr: 's',
            validationMissing: 'Veuillez saisir du texte dans les deux langues.',
            validationNoSlides: 'Aucune diapositive trouv\u00e9e. Commencez les lignes de diapositive par "#".',
            validationNoEnSlides: 'Aucune diapositive trouv\u00e9e dans le texte anglais. Utilisez "#".',
            validationNoFrSlides: 'Aucune diapositive trouv\u00e9e dans le texte fran\u00e7ais. Utilisez "#".',
            validationSlides: (enCount, frCount) => `Nombre de diapositives diff\u00e9rent : ${enCount} (EN) vs ${frCount} (FR). V\u00e9rifiez les titres \"#\".`,
            validationParagraphs: (enCount, frCount) => `Nombre de paragraphes diff\u00e9rent : ${enCount} (EN) vs ${frCount} (FR). Veuillez les aligner.`,
            modeSummarySpeech: (start, block, words, optimal) => `Discours | D\u00e9part : ${start} | Changement toutes les : ${block}s (~${words} mots)${optimal ? ` | Optimal : ${optimal}s` : ''}`,
            modeSummaryPresentation: (start, slideMode) => `Pr\u00e9sentation | D\u00e9part : ${start} | Mode : ${slideMode}`,
            exampleLoadedPresentation: 'Exemple de pr\u00e9sentation charg\u00e9.',
            exampleLoadedSpeech: 'Exemple de discours charg\u00e9.',
            exampleLoadError: 'Impossible de charger les exemples.',
            copySuccess: 'Copi\u00e9 !',
            expandEn: 'Agrandir le texte anglais',
            expandFr: 'Agrandir le texte fran\u00e7ais',
            textFormatted: 'Texte format\u00e9 !',
            descTitle: 'Ce que fait cet outil',
            descContent: 'Cet outil vous aide \u00e0 cr\u00e9er une version bilingue d\'un discours ou de notes d\'allocution. Il m\u00e9lange vos textes anglais et fran\u00e7ais en un seul script, chaque langue occupant environ la moiti\u00e9 du temps. L\'outil choisit les bons endroits pour changer de langue et d\u00e9finit la dur\u00e9e appropri\u00e9e pour rester dans une langue avant de changer.',
            // Additions
            liveMode: 'Mode direct',
            themeToggleAriaLabel: 'Changer le thème',
            langToggleAriaLabel: "Changer la langue de l'interface",
            footerLicensePrefix: 'Le contenu de ce site est sous licence',
            footerLicenseLink: 'CC BY-NC 4.0',
            footerSourcePrefix: '; veuillez créditer la source pour toute utilisation non commerciale. Le code source est disponible sur',
            footerSourceLink: 'GitHub',
            footerRights: 'Aaron Percival. Tous droits réservés.',
            practiceTitle: 'Mode Direct',
            practiceDecreaseFont: 'Diminuer la taille de la police',
            practiceIncreaseFont: 'Augmenter la taille de la police',
            practiceClose: 'Fermer le mode direct',
            practiceSpeed: 'Vitesse :',
            practiceSpeedSlow: 'Lent',
            practiceSpeedFast: 'Rapide',
            practiceSpeedNormal: 'Rythme normal',
            practiceLabelSlow: 'Lent (100)',
            practiceLabelFast: 'Rapide (180+)',
            practiceDescription: 'Rythme normal (130-160 MPM) : Courant pour la prise de parole en public. Équilibre l\'information et l\'engagement.',
            practicePlay: 'Lire',
            practicePause: 'Pause',
            practiceReset: 'Réinitialiser',
            practiceCurrent: 'Actuel',
            practiceRemaining: 'Restant',
            practiceTotal: 'Total',
            endOfSession: 'Fin de la session'
        }
    };
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };
    const applyTranslations = () => {
        const t = translations[currentLang];
        document.documentElement.lang = currentLang;
        practiceMode.setTranslations(t); // Update practice mode translations
        setText('app-title', t.appTitle);
        setText('app-subtitle', t.subtitle);
        setText('desc-title', t.descTitle);
        setHtml('desc-content', t.descContent);
        setText('step-input-title', t.stepInputTitle);
        setText('format-title', t.formatTitle || t.formattingTipsTitle);
        setHtml('format-general', t.formatGeneral);
        setHtml('format-speech', t.formatSpeech);
        setHtml('format-presentation', t.formatPresentation);
        setText('label-english', t.englishLabel);
        setText('label-french', t.frenchLabel);
        setText('load-speech-example', t.loadSpeech);
        setText('load-presentation-example', t.loadPresentation);
        setText('reset-btn', t.reset);
        setText('format-text-label', t.formatButton);
        setText('step-settings-title', t.stepSettingsTitle);
        setText('label-mode-text', t.mode);
        setText('label-mode-speech', t.speech);
        setText('label-mode-presentation', t.presentation);
        setText('label-starting-lang', t.startingLanguage);
        setText('label-start-en', t.english);
        setText('label-start-fr', t.french);
        setText('label-slide-mode', t.slideMode);
        setText('label-slide-single', t.single);
        setText('label-slide-mixed', t.mixed);
        setText('label-mixed-pattern', t.mixedModePattern);
        setText('label-pattern-alternating', t.alternating);
        setText('label-pattern-repeating', t.repeating);
        const patternTooltip = document.getElementById('pattern-tooltip');
        if (patternTooltip) patternTooltip.setAttribute('data-tooltip', t.mixedModePatternTooltip);
        setText('label-block-time', t.blockTime);
        setText('block-time-hint', t.blockHint);
        setText('label-duration-optimal', t.durationOptimal);
        setText('label-duration-manual', t.durationManual);
        if (durationTooltip) durationTooltip.setAttribute('data-tooltip', t.durationTooltip);
        if (optimalBandsTooltip) optimalBandsTooltip.setAttribute('data-tooltip', t.optimalBandsTooltip);
        setText('generate-btn', t.generate);
        setText('step-output-main-title', t.outputTitle);
        setText('output-title', t.outputTitle);
        setText('copy-btn', t.copy);
        setText('download-btn', t.download);
        const enText = document.getElementById('english-text');
        const frText = document.getElementById('french-text');
        if (enText) enText.placeholder = t.englishPlaceholder;
        if (frText) frText.placeholder = t.frenchPlaceholder;
        const modeTip = document.getElementById('mode-tooltip');
        if (modeTip) modeTip.setAttribute('data-tooltip', t.modeTip);
        const slideTip = document.getElementById('slide-tooltip');
        if (slideTip) slideTip.setAttribute('data-tooltip', t.slideTip);
        if (expandButtons && expandButtons.length) {
            if (expandButtons[0]) expandButtons[0].setAttribute('aria-label', t.expandEn);
            if (expandButtons[1]) expandButtons[1].setAttribute('aria-label', t.expandFr);
        }
        if (langToggleBtn) {
            langToggleBtn.textContent = currentLang === 'en' ? 'FR' : 'EN';
            langToggleBtn.setAttribute('aria-label', t.langToggleAriaLabel);
        }
        if (themeToggleBtn) {
            themeToggleBtn.setAttribute('aria-label', t.themeToggleAriaLabel);
        }
        if (formatTooltipIcon) formatTooltipIcon.setAttribute('data-tooltip', t.formatTooltip);
        if (practiceBtn) practiceBtn.textContent = t.liveMode;

        // Footer & Practice IDs
        setText('footer-license-text', t.footerLicensePrefix);
        setText('footer-source-text', t.footerSourcePrefix);
        setText('footer-rights', t.footerRights);
        const footerLicLink = document.querySelector('footer a[href*="creativecommons"]');
        if (footerLicLink) footerLicLink.textContent = t.footerLicenseLink;
        const footerSrcLink = document.querySelector('footer a[href*="github"]');
        if (footerSrcLink) footerSrcLink.textContent = t.footerSourceLink;

        // Practice Mode
        setText('practice-title', t.practiceTitle);
        if (document.getElementById('font-decrease-btn')) document.getElementById('font-decrease-btn').setAttribute('aria-label', t.practiceDecreaseFont);
        if (document.getElementById('font-increase-btn')) document.getElementById('font-increase-btn').setAttribute('aria-label', t.practiceIncreaseFont);
        if (document.getElementById('close-practice-btn')) document.getElementById('close-practice-btn').setAttribute('aria-label', t.practiceClose);
        setText('practice-speed-label', t.practiceSpeed);
        setText('stat-marker-left', t.practiceLabelSlow);
        setText('stat-marker-right', t.practiceLabelFast);
        setText('wpm-description', t.practiceDescription);
        setText('btn-play-label', t.practicePlay);
        setText('btn-pause-label', t.practicePause);
        setText('btn-reset-label', t.practiceReset);
        setText('stat-current-label', t.practiceCurrent);
        setText('stat-remaining-label', t.practiceRemaining);
        setText('stat-total-label', t.practiceTotal);

        setText('stat-remaining-label', t.practiceRemaining);
        setText('stat-total-label', t.practiceTotal);

        updateBlockTimeDisplay(blockTimeInput ? blockTimeInput.value : 45, t);
        renderOptimalResult();
        updateInputStats();

        // Regenerate mode summary if we have previous generation params
        if (lastGenParams) {
            const { mode, baseOptions, blockTimeValue, optimalSeconds, slideMode } = lastGenParams;
            if (mode === 'presentation') {
                // Translated values for slideMode ('single' or 'mixed')
                const smTranslated = t[slideMode] || slideMode;
                updateModeSummary(t.modeSummaryPresentation(baseOptions.startLang.toUpperCase(), smTranslated));
            } else {
                updateModeSummary(t.modeSummarySpeech(
                    baseOptions.startLang.toUpperCase(),
                    blockTimeValue,
                    blockTimeWords(blockTimeValue),
                    optimalSeconds
                ));
            }
        }
    };

    const formatTime = (seconds, t) => {
        // Match Live Mode precision (approx 1s)
        if (!isFinite(seconds)) return '--:--';
        const rounded = Math.ceil(seconds);
        if (rounded < 60) return `${rounded} ${t.sec || 'sec'}`;
        const mins = Math.floor(rounded / 60);
        const secs = rounded % 60;
        return `${mins} ${t.min || 'min'} ${secs} ${t.sec || 'sec'}`;
    };
    const blockTimeWords = (seconds) => Math.round((seconds / 60) * 150);
    const calculateOptimal = (startLangFallback = 'en') => {
        const enWords = merger.countWords(enInput.value);
        const frWords = merger.countWords(frInput.value);
        if (enWords === 0 || frWords === 0) return null;
        const enSec = merger.estimateDuration(enInput.value);
        const frSec = merger.estimateDuration(frInput.value);
        const avgMinutes = ((enSec + frSec) / 2) / 60;
        const avgWords = Math.round((enWords + frWords) / 2);

        let minTime = 15;
        let maxTime = 30;
        if (avgMinutes > 20) {
            minTime = 60;
            maxTime = 120;
        } else if (avgMinutes > 10) {
            minTime = 45;
            maxTime = 90;
        } else if (avgMinutes > 5) {
            minTime = 30;
            maxTime = 60;
        }

        const targetMid = Math.round((minTime + maxTime) / 2);
        let bestTime = targetMid;
        const enParas = merger.parseParagraphs(enInput.value);
        const frParas = merger.parseParagraphs(frInput.value);
        const startLang = document.querySelector('input[name="start-lang"]:checked')?.value || startLangFallback;

        if (enParas.length === frParas.length && enParas.length > 0) {
            let bestGap = Number.POSITIVE_INFINITY;
            for (let t = minTime; t <= maxTime; t += 5) {
                const res = merger.merge(enInput.value, frInput.value, { startLang, blockTime: t });
                const gap = Math.abs(res.enWords - res.frWords);
                if (gap < bestGap || (gap === bestGap && Math.abs(t - targetMid) < Math.abs(bestTime - targetMid))) {
                    bestGap = gap;
                    bestTime = t;
                }
            }
        }

        return { avgWords, minTime, maxTime, bestTime };
    };

    const renderOptimalResult = () => {
        if (!optimalResultEl) return;
        const t = translations[currentLang];
        if (lastOptimal) {
            const { avgWords, minTime, maxTime, bestTime } = lastOptimal;
            optimalResultEl.textContent = t.optimalResult(avgWords, minTime, maxTime, bestTime);
            optimalResultEl.style.display = 'block';
        } else {
            optimalResultEl.textContent = '';
            optimalResultEl.style.display = 'none';
        }
    };
    const syncDurationModeVisibility = () => {
        const mode = document.querySelector('input[name="mode"]:checked').value;
        const slideMode = document.querySelector('input[name="slide-mode"]:checked').value;
        const timeSetting = document.getElementById('time-setting');

        if (mode === 'presentation') {
            presentationSettings.style.display = 'flex';
            mixedPatternSettings.style.display = slideMode === 'mixed' ? 'flex' : 'none';
            timeSetting.style.display = 'none';
            if (optimalControls) optimalControls.style.display = 'none';
            if (manualControls) manualControls.style.display = 'none';
        } else {
            presentationSettings.style.display = 'none';
            mixedPatternSettings.style.display = 'none';
            timeSetting.style.display = 'flex';
            if (manualControls && optimalControls) {
                const durationMode = document.querySelector('input[name="duration-mode"]:checked')?.value || 'optimal';
                manualControls.style.display = durationMode === 'manual' ? 'flex' : 'none';
                optimalControls.style.display = durationMode === 'optimal' ? 'block' : 'none';
            }
        }
    };
    const updateModeSummary = (text) => {
        const el = document.getElementById('mode-summary');
        if (el) {
            el.textContent = text;
            el.style.display = text ? 'block' : 'none';
        }
    };
    const showValidation = (msg) => {
        const el = document.getElementById('validation-message');
        if (el) el.textContent = msg;
    };
    const setMode = (mode) => {
        const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
        if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change'));
        }
    };
    const updateBlockTimeDisplay = (seconds, t) => {
        if (blockTimeDisplay) {
            blockTimeDisplay.textContent = `${seconds}s`;
        }
    };
    const resetForm = () => {
        enInput.value = '';
        frInput.value = '';
        updateInputStats();
        setMode('speech');
        const startEn = document.getElementById('start-en');
        if (startEn) startEn.checked = true;
        const slideSingle = document.getElementById('slide-single');
        if (slideSingle) slideSingle.checked = true;
        const durationOptimalRadio = document.getElementById('duration-optimal');
        if (durationOptimalRadio) durationOptimalRadio.checked = true;
        syncDurationModeVisibility();
        lastOptimal = null;
        renderOptimalResult();
        blockTimeInput.value = 45;
        updateBlockTimeDisplay(45, translations[currentLang]);
        showValidation('');
        updateModeSummary('');
        outputPreview.textContent = '';
        outputSection.style.display = 'none';
    };
    const loadExample = async (type) => {
        try {
            const files = type === 'presentation'
                ? ['examples/EN-Presentation.txt', 'examples/FR-Presentation.txt']
                : ['examples/EN-Speech.txt', 'examples/FR-Speech.txt'];
            const [enResp, frResp] = await Promise.all(files.map(f => fetch(f)));
            if (!enResp.ok || !frResp.ok) throw new Error('Example files not found.');
            const [enText, frText] = await Promise.all([enResp.text(), frResp.text()]);
            enInput.value = enText.trim();
            frInput.value = frText.trim();
            updateInputStats();
            setMode(type);
            showValidation('');
            const t = translations[currentLang];
            updateModeSummary(type === 'presentation'
                ? t.exampleLoadedPresentation
                : t.exampleLoadedSpeech);
        } catch (err) {
            showValidation(translations[currentLang].exampleLoadError);
        }
    };
    const showToast = (message) => {
        const existing = document.querySelector('.toast-notification');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = message;
        document.body.appendChild(toast);
        // Force reflow
        toast.offsetHeight;
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    };
    const updateOptimalFromInputs = () => {
        const selected = document.querySelector('input[name="duration-mode"]:checked');
        if (selected && selected.value === 'optimal') {
            lastOptimal = null;
            renderOptimalResult();
        }
    };
    // Live word count & duration for input areas
    const updateInputStats = () => {
        const t = translations[currentLang];
        const enWords = merger.countWords(enInput.value);
        const frWords = merger.countWords(frInput.value);
        const enDurSec = merger.estimateDuration(enInput.value);
        const frDurSec = merger.estimateDuration(frInput.value);
        enCountDisplay.textContent = `${enWords} ${t.words} (~${formatTime(enDurSec, t)})`;
        frCountDisplay.textContent = `${frWords} ${t.words} (~${formatTime(frDurSec, t)})`;
        updateOptimalFromInputs();
    };
    const formatTextContent = (text) => {
        if (!text) return '';
        let normalized = text.replace(/\r\n?/g, '\n');
        // Auto-prefix "Slide X", "Diapo X", or "Diapositive X" with "# " if missing
        normalized = normalized.replace(/(^|\n)(\s*)(Slide|Diapositive|Diapo)(\s+\d+)/gi, '$1$2# $3$4');
        normalized = normalized.trimEnd();
        // Ensure a blank line after slide titles
        normalized = normalized.replace(/(^\s*#.+)(\n(?!\n))/gm, '$1\n\n');
        // Ensure a blank line between non-empty lines (paragraph separation)
        normalized = normalized.replace(/([^\n\s].*?)(\n)(?=[^\n\s])/g, '$1\n\n');
        // Collapse overly long gaps
        normalized = normalized.replace(/\n{3,}/g, '\n\n');
        return normalized.trimEnd();
    };
    enInput.addEventListener('input', updateInputStats);
    frInput.addEventListener('input', updateInputStats);
    // Auto‑suggest block time when user leaves a textarea
    const autoSetBlockTime = () => {
        const enWords = merger.countWords(enInput.value);
        const frWords = merger.countWords(frInput.value);
        if (enWords === 0 || frWords === 0) return;
        const avg = (enWords + frWords) / 2;
        let suggested = 45;
        if (avg > 3000) suggested = 90;
        else if (avg > 1500) suggested = 65;
        else if (avg > 750) suggested = 35;
        else suggested = 30;
        blockTimeInput.value = suggested;
        updateBlockTimeDisplay(suggested, translations[currentLang]);
    };
    enInput.addEventListener('change', autoSetBlockTime);
    frInput.addEventListener('change', autoSetBlockTime);
    // Slider display
    blockTimeInput.addEventListener('input', (e) => {
        updateBlockTimeDisplay(e.target.value, translations[currentLang]);
    });
    durationRadios.forEach(r => {
        r.addEventListener('change', (e) => {
            syncDurationModeVisibility();
            if (e.target.value === 'optimal') {
                lastOptimal = null;
                renderOptimalResult();
            }
        });
    });
    slideRadios.forEach(r => r.addEventListener('change', () => {
        syncDurationModeVisibility();
    }));
    syncDurationModeVisibility();
    syncDurationModeVisibility();
    applyTranslations();
    // Theme Logic
    const initTheme = () => {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            document.documentElement.setAttribute('data-theme', savedTheme);
            updateThemeIcon(savedTheme);
        } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
            updateThemeIcon('dark');
        } else {
            updateThemeIcon('light');
        }
    };
    const updateThemeIcon = (theme) => {
        if (themeIcon) {
            // SVGs using currentColor to match text color (solid black in light, solid white in dark)
            const sunSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>`;
            const moonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-3.03 0-5.5-2.47-5.5-5.5 0-1.82.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>`;
            themeIcon.innerHTML = theme === 'dark' ? sunSvg : moonSvg;
        }
    };
    const toggleTheme = () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        updateThemeIcon(newTheme);
    };
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', toggleTheme);
    }
    initTheme();
    // Mode toggle – show/hide block-time setting
    const modeRadios = document.querySelectorAll('input[name="mode"]');
    const timeSetting = document.getElementById('time-setting');
    modeRadios.forEach(r => {
        r.addEventListener('change', (e) => {
            const isSpeech = e.target.value === 'speech';
            syncDurationModeVisibility();
            if (!isSpeech) {
                lastOptimal = null;
                renderOptimalResult();
            }
        });
    });
    // Generate bilingual speech
    generateBtn.addEventListener('click', () => {
        const t = translations[currentLang];
        const enText = enInput.value;
        const frText = frInput.value;
        const mode = document.querySelector('input[name="mode"]:checked').value;
        if (!enText || !frText) {
            showValidation(t.validationMissing);
            return;
        }
        showValidation('');
        const baseOptions = {
            startLang: document.querySelector('input[name="start-lang"]:checked').value
        };
        let resultObj;
        if (mode === 'presentation') {
            const slideMode = document.querySelector('input[name="slide-mode"]:checked').value;
            const mixedPattern = document.querySelector('input[name="mixed-pattern"]:checked').value;
            const enSlides = merger.parseSlides(enText);
            const frSlides = merger.parseSlides(frText);
            if (enSlides.length === 0 && frSlides.length === 0) {
                showValidation(t.validationNoSlides);
                return;
            }
            if (enSlides.length === 0) {
                showValidation(t.validationNoEnSlides);
                return;
            }
            if (frSlides.length === 0) {
                showValidation(t.validationNoFrSlides);
                return;
            }
            if (enSlides.length !== frSlides.length) {
                showValidation(t.validationSlides(enSlides.length, frSlides.length));
                return;
            }
            // Paragraph alignment per slide
            for (let i = 0; i < enSlides.length; i++) {
                const enCount = enSlides[i]?.paragraphs?.length || 0;
                const frCount = frSlides[i]?.paragraphs?.length || 0;
                if (enCount !== frCount) {
                    showValidation(t.validationParagraphs(enCount, frCount));
                    return;
                }
            }
            resultObj = merger.mergePresentation(enText, frText, { ...baseOptions, slideMode, mixedPattern });

            // Save params for dynamic translation
            lastGenParams = { mode: 'presentation', baseOptions, slideMode };
            const smTranslated = t[slideMode] || slideMode;
            updateModeSummary(t.modeSummaryPresentation(baseOptions.startLang.toUpperCase(), smTranslated));
        } else {
            const enParas = merger.parseParagraphs(enText);
            const frParas = merger.parseParagraphs(frText);
            if (enParas.length !== frParas.length) {
                showValidation(t.validationParagraphs(enParas.length, frParas.length));
                return;
            }
            const durationMode = document.querySelector('input[name="duration-mode"]:checked')?.value || 'optimal';
            let blockTimeValue = parseInt(blockTimeInput.value, 10) || 45;
            let optimalSeconds = null;
            if (durationMode === 'optimal') {
                lastOptimal = calculateOptimal(baseOptions.startLang);
                if (lastOptimal) {
                    blockTimeValue = lastOptimal.bestTime;
                    optimalSeconds = lastOptimal.bestTime;
                }
                renderOptimalResult();
            }
            resultObj = merger.merge(enText, frText, { ...baseOptions, blockTime: blockTimeValue });

            lastGenParams = { mode: 'speech', baseOptions, blockTimeValue, optimalSeconds };
            updateModeSummary(t.modeSummarySpeech(
                baseOptions.startLang.toUpperCase(),
                blockTimeValue,
                blockTimeWords(blockTimeValue),
                optimalSeconds
            ));
        }
        // Compute durations based on actually used words
        // Compute durations based on actually used words
        const enSec = resultObj.enDur || merger.estimateDuration(resultObj.enWords); // Fallback if enDur not present (safeguard)
        const frSec = resultObj.frDur || merger.estimateDuration(resultObj.frWords);
        const totalSec = enSec + frSec;
        if (statsDiv) {
            statsDiv.innerHTML = `
                <div><strong>${t.statsEnglish}:</strong> ${resultObj.enWords} ${t.words} (~${formatTime(enSec, t)})</div>
                <div><strong>${t.statsFrench}:</strong> ${resultObj.frWords} ${t.words} (~${formatTime(frSec, t)})</div>
                <div><strong>${t.statsTotal}:</strong> ~${formatTime(totalSec, t)}</div>
            `;
        }
        outputPreview.textContent = resultObj.text;
        outputSection.style.display = 'block';
        outputSection.scrollIntoView({ behavior: 'smooth' });
    });
    // Copy to clipboard
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(outputPreview.textContent).then(() => {
            const original = copyBtn.textContent;
            copyBtn.textContent = translations[currentLang].copySuccess;
            setTimeout(() => copyBtn.textContent = original, 2000);
        });
    });
    // Download markdown file
    downloadBtn.addEventListener('click', () => {
        const blob = new Blob([outputPreview.textContent], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bilingual_speech.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
    // Expandable textareas
    let expandedWrapper = null;
    let overlay = null;
    const collapseExpanded = () => {
        if (expandedWrapper) {
            expandedWrapper.classList.remove('expanded');
            expandedWrapper = null;
        }
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
    };
    const expandWrapper = (wrapper) => {
        if (expandedWrapper === wrapper) return;
        collapseExpanded();
        expandedWrapper = wrapper;
        overlay = document.createElement('div');
        overlay.className = 'textarea-overlay';
        overlay.addEventListener('click', collapseExpanded);
        document.body.appendChild(overlay);
        wrapper.classList.add('expanded');
        const ta = wrapper.querySelector('textarea');
        if (ta) ta.focus();
    };
    expandButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const wrapper = btn.closest('.textarea-wrapper');
            if (wrapper) {
                expandWrapper(wrapper);
            }
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            collapseExpanded();
        }
    });
    if (langToggleBtn) {
        langToggleBtn.addEventListener('click', () => {
            currentLang = currentLang === 'en' ? 'fr' : 'en';
            applyTranslations();
        });
    }
    if (practiceBtn) {
        practiceBtn.addEventListener('click', () => {
            const text = outputPreview.textContent.trim();
            if (!text) {
                showValidation('Generate output first.');
                return;
            }
            practiceMode.openFromMerged(text);
        });
    }
    if (loadSpeechExampleBtn) {
        loadSpeechExampleBtn.addEventListener('click', () => loadExample('speech'));
    }
    if (loadPresentationExampleBtn) {
        loadPresentationExampleBtn.addEventListener('click', () => loadExample('presentation'));
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', () => resetForm());
    }
    if (formatTextBtn) {
        formatTextBtn.addEventListener('click', () => {
            enInput.value = formatTextContent(enInput.value);
            frInput.value = formatTextContent(frInput.value);
            updateInputStats();
            showValidation('');
            showToast(translations[currentLang].textFormatted || 'Text formatted!');
        });
    }
});
