class BilingualMerger {
    constructor() {
        this.wpm = 150; // words per minute
    }

    // Count words in a string
    countWords(text) {
        const trimmed = text.trim();
        if (!trimmed) return 0;
        return trimmed.split(/\s+/).filter(word => word.length > 0).length;
    }

    // Estimate speaking duration in seconds for a given word count
    estimateDuration(wordCount) {
        return (wordCount / this.wpm) * 60; // seconds
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
        let deltaSec = 0; // positive => English ahead in speaking time
        let streakLang = null;
        let streakDuration = 0;
        let streakCount = 0;
        const outputParas = [];
        const choices = [];

        const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
        const totalParas = enParagraphs.length + frParagraphs.length;
        const totalParaSec = enParagraphs.reduce((sum, p) => sum + this.estimateDuration(p.words), 0)
            + frParagraphs.reduce((sum, p) => sum + this.estimateDuration(p.words), 0);
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
                    deltaSec += this.estimateDuration(chosenPara.words);
                    streakLang = 'en';
                    streakDuration = this.estimateDuration(chosenPara.words);
                    streakCount = 1;
                    continue;
                } else if (options.startLang === 'fr' && frPara.words > 0) {
                    const chosenPara = frPara;
                    outputParas.push(chosenPara.text);
                    frWordsUsed += chosenPara.words;
                    deltaSec -= this.estimateDuration(chosenPara.words);
                    streakLang = 'fr';
                    streakDuration = this.estimateDuration(chosenPara.words);
                    streakCount = 1;
                    continue;
                }
            }

            const mustSwitch = streakLang && streakCount >= targetStreakCount;

            const enParaDur = this.estimateDuration(enPara.words);
            const frParaDur = this.estimateDuration(frPara.words);

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
                deltaSec += this.estimateDuration(chosenPara.words);
            } else {
                frWordsUsed += chosenPara.words;
                deltaSec -= this.estimateDuration(chosenPara.words);
            }

            if (streakLang === chosenLang) {
                streakDuration += this.estimateDuration(chosenPara.words);
                streakCount += 1;
            } else {
                streakLang = chosenLang;
                streakDuration = this.estimateDuration(chosenPara.words);
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
                    outputParas[lastIdx] = lastChoice.altText;
                    enWordsUsed = swapEn;
                    frWordsUsed = swapFr;
                }
            }
        }

        return {
            text: outputParas.join('\n\n***\n\n'),
            enWords: enWordsUsed,
            frWords: frWordsUsed
        };
    }

    // Presentation mode: build slides instead of a flowing speech.
    // slideMode: "single" (entire slide in one language) or "mixed" (half one language, half the other).
    mergePresentation(englishText, frenchText, options) {
        const enSlides = this.parseSlides(englishText);
        const frSlides = this.parseSlides(frenchText);
        const totalSlides = Math.max(enSlides.length, frSlides.length);
        const other = (lang) => lang === 'en' ? 'fr' : 'en';

        let enWordsUsed = 0;
        let frWordsUsed = 0;
        const slidesOut = [];
        let lastEndLang = options.startLang;

        for (let i = 0; i < totalSlides; i++) {
            const enSlide = enSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
            const frSlide = frSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
            const totalParas = Math.max(enSlide.paragraphs.length, frSlide.paragraphs.length);
            if (totalParas === 0) continue;

            const isLastSlide = i === totalSlides - 1;
            const startLang = options.slideMode === 'single'
                ? (i % 2 === 0 ? options.startLang : other(options.startLang))
                : (i === 0 ? options.startLang : lastEndLang);
            const otherLang = other(startLang);
            const startSlide = startLang === 'en' ? enSlide : frSlide;
            const otherSlide = startLang === 'en' ? frSlide : enSlide;
            const title = startSlide.title || otherSlide.title || `# Slide ${i + 1}`;

            if (options.slideMode === 'single') {
                let chosenLang = startSlide.words > 0 ? startLang : otherLang;
                let chosenSlide = startSlide.words > 0 ? startSlide : otherSlide;

                if (isLastSlide && otherSlide.words > 0) {
                    const currentGap = Math.abs((enWordsUsed + (chosenLang === 'en' ? chosenSlide.words : 0)) - (frWordsUsed + (chosenLang === 'fr' ? chosenSlide.words : 0)));
                    const altLang = chosenLang === 'en' ? 'fr' : 'en';
                    const altSlide = chosenLang === startLang ? otherSlide : startSlide;
                    const altGap = Math.abs((enWordsUsed + (altLang === 'en' ? altSlide.words : 0)) - (frWordsUsed + (altLang === 'fr' ? altSlide.words : 0)));
                    if (altGap < currentGap) {
                        chosenLang = altLang;
                        chosenSlide = altSlide;
                    }
                }

                slidesOut.push({ text: `${title}\n${chosenSlide.body}`.trim(), endLang: chosenLang });
                lastEndLang = chosenLang;
                if (chosenLang === 'en') enWordsUsed += chosenSlide.words; else frWordsUsed += chosenSlide.words;
            } else {
                // Mixed: first half startLang, second half otherLang; next slide starts with previous end language.
                const getPara = (lang, idx) => {
                    const arr = lang === 'en' ? enSlide.paragraphs : frSlide.paragraphs;
                    const text = arr[idx] || '';
                    return { text, words: this.countWords(text) };
                };

                const half = Math.ceil(totalParas / 2);
                const assignments = Array.from({ length: totalParas }, (_, idx) => idx < half ? startLang : otherLang);

                let slideEn = 0;
                let slideFr = 0;
                const paraOrder = [];
                for (let idx = 0; idx < totalParas; idx++) {
                    const useLang = assignments[idx];
                    const primary = getPara(useLang, idx);
                    const fallback = getPara(useLang === 'en' ? 'fr' : 'en', idx);
                    const chosen = primary.text ? primary : fallback;
                    if (!chosen.text) continue;
                    paraOrder.push({ text: chosen.text, lang: useLang, words: chosen.words });
                    if (useLang === 'en') slideEn += chosen.words; else slideFr += chosen.words;
                }

                // Only on last slide, consider swapping the last paragraph to balance totals.
                if (isLastSlide && paraOrder.length > 0) {
                    const lastIdx = paraOrder.length - 1;
                    const lastLang = paraOrder[lastIdx].lang;
                    const lastWords = paraOrder[lastIdx].words;
                    const lastParaText = paraOrder[lastIdx].text;
                    const swapLang = lastLang === 'en' ? 'fr' : 'en';
                    const alt = getPara(swapLang, totalParas - 1);
                    if (alt.text) {
                        let altEn = slideEn;
                        let altFr = slideFr;
                        if (lastLang === 'en') {
                            altEn = slideEn - lastWords;
                            altFr = slideFr + alt.words;
                        } else {
                            altFr = slideFr - lastWords;
                            altEn = slideEn + alt.words;
                        }
                        const baseGap = Math.abs((enWordsUsed + slideEn) - (frWordsUsed + slideFr));
                        const altGap = Math.abs((enWordsUsed + altEn) - (frWordsUsed + altFr));
                        if (altGap < baseGap) {
                            paraOrder[lastIdx] = { text: alt.text, lang: swapLang, words: alt.words };
                            slideEn = altEn;
                            slideFr = altFr;
                        } else {
                            // keep original
                            paraOrder[lastIdx] = { text: lastParaText, lang: lastLang, words: lastWords };
                        }
                    }
                }

                const parts = [title];
                if (paraOrder.length > 0) parts.push(paraOrder.map(p => p.text).join('\n\n'));
                const endLang = paraOrder.length ? paraOrder[paraOrder.length - 1].lang : startLang;
                slidesOut.push({ text: parts.join('\n\n').trim(), endLang });
                lastEndLang = endLang;
                enWordsUsed += slideEn;
                frWordsUsed += slideFr;
            }
        }

        return {
            text: slidesOut.map(s => s.text).join('\n\n***\n\n'),
            enWords: enWordsUsed,
            frWords: frWordsUsed
        };
    }
}

// UI Controller
document.addEventListener('DOMContentLoaded', () => {
    const merger = new BilingualMerger();

    // Elements
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
    const statsDiv = document.getElementById('result-stats');
    const presentationSettings = document.getElementById('presentation-settings');
    const validationMessage = document.getElementById('validation-message');
    const modeSummary = document.getElementById('mode-summary');
    const durationRadios = document.querySelectorAll('input[name="duration-mode"]');
    const optimalControls = document.getElementById('optimal-controls');
    const manualControls = document.getElementById('manual-controls');
    const optimalResultEl = document.getElementById('optimal-result');
    const durationTooltip = document.getElementById('duration-tooltip');
    const optimalBandsTooltip = document.getElementById('optimal-bands-tooltip');
    const expandButtons = document.querySelectorAll('.expand-btn');
    const loadSpeechExampleBtn = document.getElementById('load-speech-example');
    const loadPresentationExampleBtn = document.getElementById('load-presentation-example');
    const resetBtn = document.getElementById('reset-btn');
    const langToggleBtn = document.getElementById('lang-toggle');

    // Helper: format seconds as "X min Y sec" with seconds rounded to nearest 5
    const formatTime = (seconds, t) => {
        let mins = Math.floor(seconds / 60);
        let secs = Math.round((seconds % 60) / 5) * 5;
        if (secs === 60) {
            secs = 0;
            mins += 1;
        }
        return mins > 0 ? `${mins} ${t.minAbbr} ${secs} ${t.secAbbr}` : `${secs} ${t.secAbbr}`;
    };

    const blockTimeWords = (seconds) => Math.round(seconds * (merger.wpm / 60));

    const updateBlockTimeDisplay = (value, t) => {
        const text = `${value}s (~${blockTimeWords(value)} ${t ? t.words : 'words'})`;
        blockTimeDisplay.textContent = text;
    };

    const showValidation = (message) => {
        if (!validationMessage) return;
        validationMessage.textContent = message || '';
        validationMessage.style.display = message ? 'block' : 'none';
    };

    const updateModeSummary = (text) => {
        if (!modeSummary) return;
        if (text) {
            modeSummary.textContent = text;
            modeSummary.style.display = 'block';
        } else {
            modeSummary.textContent = '';
            modeSummary.style.display = 'none';
        }
    };

    const setMode = (mode) => {
        const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
        if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
    };

    const syncDurationModeVisibility = () => {
        const selected = document.querySelector('input[name="duration-mode"]:checked');
        const mode = selected ? selected.value : 'optimal';
        if (optimalControls) optimalControls.style.display = mode === 'optimal' ? 'block' : 'none';
        if (manualControls) manualControls.style.display = mode === 'manual' ? 'block' : 'none';
    };

    const translations = {
        en: {
            appTitle: 'Bilingual Text Generator',
            subtitle: 'Create a balanced bilingual speech or presentation, alternating between the full English and French versions provided',
            stepInputTitle: 'Enter Text',
            stepSettingsTitle: 'Configure & Generate',
            englishLabel: 'English Version',
            frenchLabel: 'French Version',
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
            minAbbr: 'min',
            secAbbr: 'sec',
            validationMissing: 'Please enter text for both languages.',
            validationSlides: (enCount, frCount) => `Slide count mismatch: English has ${enCount}, French has ${frCount}. Check your "#" headings.`,
            validationParagraphs: (enCount, frCount) => `Paragraph count mismatch: English has ${enCount}, French has ${frCount}. Please align them.`,
            modeSummarySpeech: (start, block, words, optimal) => `Speech | Start: ${start} | Switch every: ${block}s (~${words} words)${optimal ? ` | Optimal: ${optimal}s` : ''}`,
            modeSummaryPresentation: (start, slideMode) => `Presentation | Start: ${start} | Mode: ${slideMode}`,
            exampleLoadedPresentation: 'Presentation example loaded.',
            exampleLoadedSpeech: 'Speech example loaded.',
            exampleLoadError: 'Could not load examples.',
            copySuccess: 'Copied!',
            expandEn: 'Expand English text',
            expandFr: 'Expand French text'
        },
        fr: {
            appTitle: 'G\u00e9n\u00e9rateur de texte bilingue',
            subtitle: 'Cr\u00e9ez un discours ou une pr\u00e9sentation bilingue \u00e9quilibr\u00e9, en alternant entre les versions compl\u00e8tes anglaise et fran\u00e7aise fournies',
            stepInputTitle: 'Saisir le texte',
            stepSettingsTitle: 'Configurer et g\u00e9n\u00e9rer',
            englishLabel: 'Version anglaise',
            frenchLabel: 'Version fran\u00e7aise',
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
            optimalBandsTooltip: `Blocs sugg\u00e9r\u00e9s :\nTemps de discours : 0-5 min | Bloc : 15-30s\nTemps de discours : 5-10 min | Bloc : 30-60s\nTemps de discours : 10-20 min | Bloc : 45-90s\nTemps de discours : 20+ min | Bloc : 60-120s`,
            generate: 'G\u00e9n\u00e9rer le texte bilingue',
            outputTitle: 'Texte bilingue',
            copy: 'Copier',
            download: 'T\u00e9l\u00e9charger .md',
            statsEnglish: 'Anglais',
            statsFrench: 'Fran\u00e7ais',
            statsTotal: 'Total',
            words: 'mots',
            minAbbr: 'min',
            secAbbr: 's',
            validationMissing: 'Veuillez saisir du texte dans les deux langues.',
            validationSlides: (enCount, frCount) => `Nombre de diapositives diff\u00e9rent : ${enCount} (EN) vs ${frCount} (FR). V\u00e9rifiez les titres \"#\".`,
            validationParagraphs: (enCount, frCount) => `Nombre de paragraphes diff\u00e9rent : ${enCount} (EN) vs ${frCount} (FR). Veuillez les aligner.`,
            modeSummarySpeech: (start, block, words, optimal) => `Discours | D\u00e9part : ${start} | Changement toutes les : ${block}s (~${words} mots)${optimal ? ` | Optimal : ${optimal}s` : ''}`,
            modeSummaryPresentation: (start, slideMode) => `Pr\u00e9sentation | D\u00e9part : ${start} | Mode : ${slideMode}`,
            exampleLoadedPresentation: 'Exemple de pr\u00e9sentation charg\u00e9.',
            exampleLoadedSpeech: 'Exemple de discours charg\u00e9.',
            exampleLoadError: 'Impossible de charger les exemples.',
            copySuccess: 'Copi\u00e9 !',
            expandEn: 'Agrandir le texte anglais',
            expandFr: 'Agrandir le texte fran\u00e7ais'
        }
    };

    let currentLang = 'en';
    let lastOptimal = null;

    const calculateOptimal = (startLangFallback = 'en') => {
        const enWords = merger.countWords(enInput.value);
        const frWords = merger.countWords(frInput.value);
        if (enWords === 0 || frWords === 0) return null;
        const enSec = merger.estimateDuration(enWords);
        const frSec = merger.estimateDuration(frWords);
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

    const applyTranslations = () => {
        const t = translations[currentLang];
        document.documentElement.lang = currentLang;
        document.title = t.appTitle;
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        setText('app-title', t.appTitle);
        setText('app-subtitle', t.subtitle);
        setText('step-input-title', t.stepInputTitle);
        setText('step-settings-title', t.stepSettingsTitle);
        setText('label-english', t.englishLabel);
        setText('label-french', t.frenchLabel);
        setText('format-title', t.formatTitle);
        const setHTML = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = value;
        };
        setHTML('format-speech', t.formatSpeech);
        setHTML('format-presentation', t.formatPresentation);
        setHTML('format-general', t.formatGeneral);
        setText('load-speech-example', t.loadSpeech);
        setText('load-presentation-example', t.loadPresentation);
        setText('reset-btn', t.reset);
        setText('settings-title', t.settings);
        setText('label-mode-text', t.mode);
        setText('label-mode-speech', t.speech);
        setText('label-mode-presentation', t.presentation);
        setText('label-starting-lang', t.startingLanguage);
        setText('label-start-en', t.english);
        setText('label-start-fr', t.french);
        setText('label-slide-mode', t.slideMode);
        setText('label-slide-single', t.single);
        setText('label-slide-mixed', t.mixed);
        setText('label-block-time', t.blockTime);
        setText('block-time-hint', t.blockHint);
        setText('label-duration-optimal', t.durationOptimal);
        setText('label-duration-manual', t.durationManual);
        if (durationTooltip) durationTooltip.setAttribute('data-tooltip', t.durationTooltip);
        if (optimalBandsTooltip) optimalBandsTooltip.setAttribute('data-tooltip', t.optimalBandsTooltip);
        setText('generate-btn', t.generate);
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
        if (langToggleBtn) langToggleBtn.textContent = currentLang === 'en' ? 'FR' : 'EN';
        updateBlockTimeDisplay(blockTimeInput.value, t);
        renderOptimalResult();
        updateInputStats();
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
        const enDurMin = Math.round(merger.estimateDuration(enWords) / 60);
        const frDurMin = Math.round(merger.estimateDuration(frWords) / 60);
        enCountDisplay.textContent = `${enWords} ${t.words} (~${enDurMin} ${t.minAbbr})`;
        frCountDisplay.textContent = `${frWords} ${t.words} (~${frDurMin} ${t.minAbbr})`;
        updateOptimalFromInputs();
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

    syncDurationModeVisibility();
    applyTranslations();

    // Mode toggle – show/hide block-time setting
    const modeRadios = document.querySelectorAll('input[name="mode"]');
    const timeSetting = document.getElementById('time-setting');
    modeRadios.forEach(r => {
        r.addEventListener('change', (e) => {
            const isSpeech = e.target.value === 'speech';
            timeSetting.style.display = isSpeech ? 'flex' : 'none';
            presentationSettings.style.display = isSpeech ? 'none' : 'flex';
            if (isSpeech) {
                syncDurationModeVisibility();
            } else {
                if (optimalControls) optimalControls.style.display = 'none';
                if (manualControls) manualControls.style.display = 'none';
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
            const enSlides = merger.parseSlides(enText);
            const frSlides = merger.parseSlides(frText);
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
            resultObj = merger.mergePresentation(enText, frText, { ...baseOptions, slideMode });
            updateModeSummary(t.modeSummaryPresentation(baseOptions.startLang.toUpperCase(), slideMode));
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
            updateModeSummary(t.modeSummarySpeech(
                baseOptions.startLang.toUpperCase(),
                blockTimeValue,
                blockTimeWords(blockTimeValue),
                optimalSeconds
            ));
        }

        // Compute durations based on actually used words
        const enSec = merger.estimateDuration(resultObj.enWords);
        const frSec = merger.estimateDuration(resultObj.frWords);
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

    if (loadSpeechExampleBtn) {
        loadSpeechExampleBtn.addEventListener('click', () => loadExample('speech'));
    }
    if (loadPresentationExampleBtn) {
        loadPresentationExampleBtn.addEventListener('click', () => loadExample('presentation'));
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', () => resetForm());
    }
});
