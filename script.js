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
    // mixedPattern: "alternating" (default) or "repeating".
    mergePresentation(englishText, frenchText, options) {
        const enSlides = this.parseSlides(englishText);
        const frSlides = this.parseSlides(frenchText);
        const totalSlides = Math.max(enSlides.length, frSlides.length);
        const other = (lang) => lang === 'en' ? 'fr' : 'en';
        // Helper to formatting
        const formatTitle = (s) => s.title ? s.title + '\n\n' : '';
        if (options.slideMode === 'single') {
            let resultText = '';
            for (let i = 0; i < totalSlides; i++) {
                const enSlide = enSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
                const frSlide = frSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
                if (enSlide.body) resultText += formatTitle(enSlide) + enSlide.body + '\n\n---\n\n';
                if (frSlide.body) resultText += formatTitle(frSlide) + frSlide.body + '\n\n---\n\n';
            }
            return {
                text: resultText.trim(),
                enWords: enSlides.reduce((s, sl) => s + sl.words, 0),
                frWords: frSlides.reduce((s, sl) => s + sl.words, 0)
            };
        } else {
            // Mixed Mode
            let resultText = '';
            let enWordsTotal = 0;
            let frWordsTotal = 0;
            for (let i = 0; i < totalSlides; i++) {
                const enSlide = enSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
                const frSlide = frSlides[i] || { title: `# Slide ${i + 1}`, body: '', paragraphs: [], words: 0 };
                const combinedTitle = enSlide.title || frSlide.title;
                resultText += combinedTitle + '\n\n';
                const paraMax = Math.max(enSlide.paragraphs.length, frSlide.paragraphs.length);
                for (let p = 0; p < paraMax; p++) {
                    const enP = enSlide.paragraphs[p];
                    const frP = frSlide.paragraphs[p];
                    if (options.mixedPattern === 'alternating') {
                        if (i % 2 === 0) {
                            if (enP) { resultText += enP + '\n\n'; enWordsTotal += this.countWords(enP); }
                            if (frP) { resultText += frP + '\n\n'; frWordsTotal += this.countWords(frP); }
                        } else {
                            if (frP) { resultText += frP + '\n\n'; frWordsTotal += this.countWords(frP); }
                            if (enP) { resultText += enP + '\n\n'; enWordsTotal += this.countWords(enP); }
                        }
                    } else {
                        if (enP) { resultText += enP + '\n\n'; enWordsTotal += this.countWords(enP); }
                        if (frP) { resultText += frP + '\n\n'; frWordsTotal += this.countWords(frP); }
                    }
                }
                resultText += '---\n\n';
            }
            return {
                text: resultText.trim(),
                enWords: enWordsTotal,
                frWords: frWordsTotal
            };
        }
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
        this.fontSize = 150;
        this.bindEvents();
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
        const lines = mergedText.split(/\n+/).map(l => l.trim()).filter(Boolean);
        this.content = lines.map(text => ({ text, lang: 'mix', words: text.split(/\s+/) }));
        if (!this.overlay || this.content.length === 0) return;
        this.totalWords = this.content.reduce((acc, sent) => acc + sent.words.length, 0);
        this.overlay.classList.add('active');
        this.overlay.style.display = 'block';
        this.overlay.setAttribute('aria-hidden', 'false');
        this.reset();
        this.updateTotalDuration();
        this.applyFontSize();
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
            if (this.wpm < 110) this.wpmGuidance.textContent = 'Slow pace';
            else if (this.wpm > 180) this.wpmGuidance.textContent = 'Fast pace';
            else this.wpmGuidance.textContent = 'Normal pace';
        }
    }
    changeFontSize(delta) {
        this.fontSize = Math.max(50, Math.min(200, this.fontSize + delta));
        this.applyFontSize();
    }
    applyFontSize() {
        if (this.prevText) this.prevText.style.fontSize = `${this.fontSize}%`;
        if (this.currentText) this.currentText.style.fontSize = `${this.fontSize}%`;
        if (this.nextText) this.nextText.style.fontSize = `${this.fontSize}%`;
        if (this.practiceContent) this.practiceContent.style.fontSize = `${this.fontSize}%`;
    }
    runCountdown() {
        const target = this.currentText || this.practiceContent;
        if (!target) return Promise.resolve();
        return new Promise(resolve => {
            let count = 3;
            target.textContent = count;
            target.style.opacity = 1;
            const int = setInterval(() => {
                count--;
                if (count > 0) {
                    target.textContent = count;
                } else {
                    clearInterval(int);
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

        // Determine which word is currently active based on elapsed time for this sentence
        // We need a local counter for the word index within the current sentence
        if (typeof this.currentSentenceWordIdx === 'undefined') {
            this.currentSentenceWordIdx = 0;
        }

        this.updateThreeSentences();
        this.updateRunningTimers();

        // Check if we finished the sentence
        if (this.currentSentenceWordIdx >= totalSentenceWords) {
             // Calculate pause duration based on punctuation
            let pause = 0;
            const lastChar = currentSentence.text.slice(-1);
            if ('.!?'.includes(lastChar)) pause = this.baseDelay * 3.0; // 3x beat pause
            else if (',;:'.includes(lastChar)) pause = this.baseDelay * 1.5; // 1.5x beat pause
            
            // Wait for the pause, then move to next sentence
            this.timer = setTimeout(() => {
                this.currentIndex++;
                this.currentSentenceWordIdx = 0; // Reset for next sentence
                this.tick();
            }, pause);
        } else {
             // Move to next word
            this.timer = setTimeout(() => {
                this.currentSentenceWordIdx++;
                this.currentWordGlobalIdx++;
                this.tick();
            }, this.baseDelay);
        }
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
            this.currentText.innerHTML = curr ? this.highlight(curr, this.currentSentenceWordIdx) : 'End of session';
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
        const words = this.totalWords;
        const sentences = this.content.length;
        const pauseTime = sentences * (this.baseDelay * 4);
        return (words * this.baseDelay) + pauseTime;
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
document.addEventListener('DOMContentLoaded', () => {
    const merger = new BilingualMerger();
    const practiceMode = new PracticeController();
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
    const durationRadios = document.querySelectorAll('input[name="duration-mode"]');
    const slideRadios = document.querySelectorAll('input[name="slide-mode"]');
    const statsDiv = document.getElementById('result-stats');
    const presentationSettings = document.getElementById('presentation-settings');
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
    const translations = {
        en: {
            title: "Bilingual Text Generator",
            subtitle: "Create perfectly timed bilingual speeches and presentations.",
            descTitle: "What this tool does",
            descContent: "Merge English and French paragraphs with balanced timing. Speech mode flows paragraph-by-paragraph; presentation mode aligns slides marked with '#'.",
            stepInputTitle: "Add your text",
            formatTitle: "Formatting tips",
            formatGeneral: "Separate paragraphs with a blank line for the cleanest alignment.",
            formatSpeech: "Speech mode expects paragraph counts to match between languages.",
            formatPresentation: "Use '#' before slide titles (e.g., '# Slide 1') for presentation mode.",
            englishLabel: "English",
            frenchLabel: "French",
            englishPlaceholder: "Paste English text here...",
            frenchPlaceholder: "Paste French text here...",
            blockTime: "Block Time (sec):",
            blockHint: "Target duration for each language block",
            generate: "Generate Bilingual Text",
            reset: "Reset",
            copy: "Copy to Clipboard",
            download: "Download .md",
            validationMissing: "Please enter text in both languages.",
            validationParagraphs: (e, f) => `Paragraph count mismatch: English (${e}), French (${f}).`,
            validationSlides: (e, f) => `Slide count mismatch: English (${e}), French (${f}).`,
            validationNoSlides: "No slides found (use # for titles).",
            validationNoEnSlides: "No English slides found (use # for titles).",
            validationNoFrSlides: "No French slides found (use # for titles).",
            statsEnglish: "English",
            statsFrench: "French",
            statsTotal: "Total",
            words: "words",
            copySuccess: "Copied!",
            exampleLoadedSpeech: "Speech example loaded.",
            exampleLoadedPresentation: "Presentation example loaded.",
            exampleLoadError: "Error loading examples.",
            modeSummarySpeech: (sl, bt, bw, opt) => `Speech mode: starting ${sl}, blocks ~${bt}s.`,
            modeSummaryPresentation: (sl, sm) => `Presentation mode: starting ${sl}, slide mode ${sm}.`,
            loadSpeech: "Load Speech Example",
            loadPresentation: "Load Presentation Example",
            formatButton: "Format Text",
            settings: "Settings",
            stepSettingsTitle: "Settings & generate",
            stepOutputTitle: "Your merged text",
            mode: "Mode:",
            speech: "Speech",
            presentation: "Presentation",
            startingLanguage: "Starting language:",
            english: "English",
            french: "French",
            slideMode: "Slide mode:",
            single: "Single",
            mixed: "Mixed",
            mixedModePattern: "Mixed pattern:",
            alternating: "Alternating",
            repeating: "Repeating",
            mixedModePatternTooltip: "Alternating: EN then FR on alternating slides. Repeating: EN then FR on every slide.",
            durationOptimal: "Optimal",
            durationManual: "Manual",
            durationTooltip: "Optimal calculates a recommended block time from your text.",
            optimalBandsTooltip: "Shows the recommended switch interval based on rhythm.",
            outputTitle: "Merged Output",
            modeTip: "Speech flows continuously. Presentation outputs slides.",
            slideTip: "Use # at the start of lines for slide titles.",
            expandEn: "Expand English input",
            expandFr: "Expand French input",
            formatTooltip: "Auto-format text for better processing.",
            textFormatted: "Text formatted!",
            liveMode: "Live Mode"
        },
        fr: {
            title: "Générateur de texte bilingue",
            subtitle: "Créez des discours et présentations bilingues parfaitement synchronisés.",
            descTitle: "Ce que fait l'outil",
            descContent: "Fusionnez des paragraphes anglais et français tout en équilibrant le temps de parole. Le mode discours suit les paragraphes ; le mode présentation aligne les diapositives marquées par '#'.",
            stepInputTitle: "Ajoutez vos textes",
            formatTitle: "Conseils de formatage",
            formatGeneral: "Séparez chaque paragraphe par une ligne vide pour faciliter l'alignement.",
            formatSpeech: "Le mode discours attend le même nombre de paragraphes dans chaque langue.",
            formatPresentation: "Utilisez '#' devant les titres de diapos (ex. \"# Diapo 1\") pour le mode présentation.",
            englishLabel: "Anglais",
            frenchLabel: "Français",
            englishPlaceholder: "Collez le texte anglais ici...",
            frenchPlaceholder: "Collez le texte français ici...",
            blockTime: "Durée des blocs (s) :",
            blockHint: "Durée cible avant de changer de langue",
            generate: "Générer le texte bilingue",
            reset: "Réinitialiser",
            copy: "Copier",
            download: "Télécharger .md",
            validationMissing: "Veuillez saisir du texte dans les deux langues.",
            validationParagraphs: (e, f) => `Nombre de paragraphes différent : Anglais (${e}), Français (${f}).`,
            validationSlides: (e, f) => `Nombre de diapositives différent : Anglais (${e}), Français (${f}).`,
            validationNoSlides: "Aucune diapositive trouvée (utilisez # pour les titres).",
            validationNoEnSlides: "Aucune diapositive en anglais trouvée (utilisez # pour les titres).",
            validationNoFrSlides: "Aucune diapositive en français trouvée (utilisez # pour les titres).",
            statsEnglish: "Anglais",
            statsFrench: "Français",
            statsTotal: "Total",
            words: "mots",
            copySuccess: "Copié !",
            exampleLoadedSpeech: "Exemple de discours chargé.",
            exampleLoadedPresentation: "Exemple de présentation chargé.",
            exampleLoadError: "Erreur lors du chargement des exemples.",
            modeSummarySpeech: (sl, bt, bw, opt) => `Mode discours : départ ${sl}, blocs ~${bt}s.`,
            modeSummaryPresentation: (sl, sm) => `Mode présentation : départ ${sl}, mode ${sm}.`,
            loadSpeech: "Charger un exemple (discours)",
            loadPresentation: "Charger un exemple (présentation)",
            formatButton: "Mettre en forme le texte",
            settings: "Paramètres",
            stepSettingsTitle: "Réglages et génération",
            stepOutputTitle: "Texte fusionné",
            mode: "Mode :",
            speech: "Discours",
            presentation: "Présentation",
            startingLanguage: "Langue de départ :",
            english: "Anglais",
            french: "Français",
            slideMode: "Mode diapo :",
            single: "Unique",
            mixed: "Mixte",
            mixedModePattern: "Motif mixte :",
            alternating: "Alterné",
            repeating: "Répété",
            mixedModePatternTooltip: "Alterné : EN puis FR un slide sur deux. Répété : EN puis FR sur chaque diapo.",
            durationOptimal: "Optimal",
            durationManual: "Manuel",
            durationTooltip: "Optimal calcule une durée conseillée à partir de vos textes.",
            optimalBandsTooltip: "Affiche l'intervalle de changement recommandé.",
            outputTitle: "Résultat fusionné",
            modeTip: "Discours = texte continu. Présentation = diapositives.",
            slideTip: "Ajoutez # au début des titres de diapos.",
            expandEn: "Agrandir le texte anglais",
            expandFr: "Agrandir le texte français",
            formatTooltip: "Formater automatiquement le texte pour de meilleurs résultats.",
            textFormatted: "Texte formaté !",
            liveMode: "Mode direct"
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
        setText('app-title', t.title);
        setText('app-subtitle', t.subtitle);
        setText('desc-title', t.descTitle || t.formatTitle || t.formattingTipsTitle);
        setHtml('desc-content', t.descContent || t.formattingTips || '');
        setText('step-input-title', t.stepInputTitle);
        setText('format-title', t.formatTitle || t.formattingTipsTitle);
        setText('format-general', t.formatGeneral || t.formattingTips);
        setText('format-speech', t.formatSpeech || '');
        setText('format-presentation', t.formatPresentation || '');
        setText('label-english', t.englishLabel || t.english);
        setText('label-french', t.frenchLabel || t.french);
        setText('load-speech-example', t.loadSpeech);
        setText('load-presentation-example', t.loadPresentation);
        setText('reset-btn', t.reset);
        setText('format-text-label', t.formatButton);
        setText('step-settings-title', t.stepSettingsTitle || t.settings);
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
        setText('step-output-main-title', t.stepOutputTitle || t.outputTitle);
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
        if (formatTooltipIcon) formatTooltipIcon.setAttribute('data-tooltip', t.formatTooltip);
        if (practiceBtn) practiceBtn.textContent = t.liveMode;
        updateBlockTimeDisplay(blockTimeInput ? blockTimeInput.value : 45, t);
        renderOptimalResult();
        updateInputStats();
    };
    const formatTime = (seconds, t) => {
        // Simple MM:SS formatter
        if (!isFinite(seconds)) return '--:--';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    const blockTimeWords = (seconds) => Math.round((seconds / 60) * 150);
    const calculateOptimal = (startLang) => {
        return { bestTime: 45, bands: [] }; // Stub
    };
    const renderOptimalResult = () => {
        // Placeholder
    };
    const syncDurationModeVisibility = () => {
        if (manualControls && optimalControls) {
            const mode = document.querySelector('input[name="duration-mode"]:checked')?.value || 'optimal';
            manualControls.style.display = mode === 'manual' ? 'flex' : 'none';
            optimalControls.style.display = mode === 'optimal' ? 'block' : 'none';
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
        // Stub to prevent crash
        const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
        if (radio) radio.checked = true;
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
        const enDurSec = merger.estimateDuration(enWords);
        const frDurSec = merger.estimateDuration(frWords);
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
