// script.js

// ----------------------------------------------------
// 1. ES MODULE IMPORTS 
// ----------------------------------------------------
// Import lesson data and conversation data from their files
import { LESSONS_1_50 } from "./data/LESSONS_1_50.js"; 
// Next LESSON COME HERE
//import { LESSONS_51_100 } from "./data/LESSONS_51_100.js"; 
import { CONVERSATIONS_1_20 } from "./data/CONVERSATIONS_1_20.js";

// Pull global Firebase object loaded from compat scripts in index.html
const fbase = window.firebase || {};
const { initializeApp, getFirestore, getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } = fbase;
const firestore = fbase.firestore || {};
const { doc, onSnapshot, setDoc } = firestore;


// --- GLOBAL STATE (CRITICAL INITIALIZATION) ---
// Initialize config variables to a safe default object/null 
// in case they are not defined in the HTML before the module loads.
window.firebaseConfig = window.firebaseConfig || {}; 
window.appId = window.appId || "unknown-app-id"; 
window.initialAuthToken = window.initialAuthToken || null; 

let app, db, auth;
let userId = null;
let isAuthReady = false;

// Voice recording state
let mediaRecorder;
let audioChunks = [];
let recordedAudioBlob = null;
let isRecording = false;

// Application state 
window.currentProgress = {};
window.currentLessonIndex = 0;
window.currentCardIndex = 0;
window.isFlipped = false;
window.currentMode = 'practice'; // 'practice', 'review', or 'conversations'
window.activeCardList = [];
window.currentConversationIndex = 0;
window.currentConversationLevel = 1; // NEW: Track the current conversation level

// Combine the arrays using the valid imported names
window.LESSONS = [ 
    ...LESSONS_1_50, 
    // Next LESSON COME HERE
    //...LESSONS_51_100 
]; 

window.CONVERSATIONS = CONVERSATIONS_1_20;

// Expose Firebase functions globally for the same reason
window.initializeApp = initializeApp;
window.getFirestore = getFirestore;
window.getAuth = getAuth;
window.signInAnonymously = signInAnonymously;
window.onAuthStateChanged = onAuthStateChanged;
window.signInWithCustomToken = signInWithCustomToken;
window.doc = doc;
window.onSnapshot = onSnapshot;
window.setDoc = setDoc;


// --- FIREBASE/FIRESTORE FUNCTIONS ---

const getProgressDocRef = () => {
    if (!userId) return null;
    const progressCollectionPath = `/artifacts/${window.appId}/users/${userId}/french_progress`;
    return window.doc(db, progressCollectionPath, "data");
};

const loadProgress = () => {
    const docRef = getProgressDocRef();
    if (!docRef || !isAuthReady) return;

    window.onSnapshot(docRef, (docSnap) => {
        if (docSnap.exists()) {
            window.currentProgress = docSnap.data().progress || {};
            if (window.LESSONS && window.LESSONS.length > 0) {
                window.activeCardList = window.LESSONS[window.currentLessonIndex].cards; 
            }
            renderApp();
        } else {
            window.currentProgress = {};
            if (window.LESSONS && window.LESSONS.length > 0) {
                window.activeCardList = window.LESSONS[window.currentLessonIndex].cards;
            }
            renderApp();
        }
    }, (error) => {
        console.error("Error listening to progress:", error);
    });
};

const saveProgress = async () => {
    const docRef = getProgressDocRef();
    if (!docRef || !isAuthReady) {
        console.warn("Cannot save progress: Firestore not ready or unauthorized.");
        return;
    }

    const dataToSave = {
        progress: window.currentProgress,
        lastUpdated: new Date().toISOString()
    };

    try {
        await window.setDoc(docRef, dataToSave, { merge: true });
    } catch (error) {
        console.error("Failed to save progress:", error);
        showNotification("Failed to save progress. Check console for details.", 'error');
    }
};

const initFirebase = async () => {
    try {
        if (!window.LESSONS || window.LESSONS.length === 0) {
            document.getElementById('loading-message').textContent = "Error: Lesson data (window.LESSONS) is missing or empty.";
            console.error("Initialization failed: Lesson data is missing or empty.");
            return;
        }

        // Object.keys check is now safe due to the initialization at the top
        if (Object.keys(window.firebaseConfig).length === 0) {
            // Offline/No-Firebase mode fallback
            isAuthReady = true;
            userId = crypto.randomUUID();
            window.activeCardList = window.LESSONS[0].cards;
            document.getElementById('user-id-display').textContent = `User ID: ${userId.substring(0, 8)}... (Offline)`;
            renderApp();
            return;
        }

        // Initialize Firebase
        app = window.initializeApp(window.firebaseConfig);
        db = window.getFirestore(app);
        auth = window.getAuth(app);

        const authPromise = new Promise(resolve => {
            window.onAuthStateChanged(auth, async (user) => {
                if (user) { userId = user.uid; }
                else {
                    // Attempt silent or anonymous sign-in
                    try {
                        const userCredential = window.initialAuthToken 
                            ? await window.signInWithCustomToken(auth, window.initialAuthToken)
                            : await window.signInAnonymously(auth);
                        userId = userCredential.user.uid;
                    } catch (error) {
                        console.error("Authentication failed:", error);
                        userId = crypto.randomUUID(); 
                    }
                }
                isAuthReady = true;
                resolve();
            });
        });

        await authPromise;
        document.getElementById('user-id-display').textContent = `User ID: ${userId.substring(0, 8)}...`;
        loadProgress();
    } catch (error) {
        console.error("Failed to initialize Firebase:", error);
        document.getElementById('loading-message').textContent = "Error initializing Firebase. Check console.";
    }
};


// --- AUDIO UTILITY FUNCTIONS ---

window.handleListenClick = (text) => {
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }
    
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'fr-FR'; 
        
        const voices = window.speechSynthesis.getVoices();
        const frenchVoice = voices.find(voice => voice.lang === 'fr-FR' || voice.lang.startsWith('fr'));
        
        if (frenchVoice) {
            utterance.voice = frenchVoice;
        }
        
        utterance.rate = 1.0; 
        
        window.speechSynthesis.speak(utterance);
    } else {
        showNotification("Browser does not support native Text-to-Speech.", 'error');
    }
};

window.toggleRecording = async () => {
    const recordBtn = document.getElementById('record-btn') || document.getElementById('record-btn-flashcard');
    const playBtn = document.getElementById('play-btn') || document.getElementById('play-btn-flashcard');
    
    if (!recordBtn || !playBtn) return; 
            
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showNotification("Microphone access not supported in this browser/environment.", 'error');
        return;
    }
    
    if (!isRecording) {
        // Start recording
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            recordedAudioBlob = null;

            mediaRecorder.ondataavailable = event => { audioChunks.push(event.data); };

            mediaRecorder.onstop = () => {
                recordedAudioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
                stream.getTracks().forEach(track => track.stop());
                
                recordBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg> Start Recording`;
                recordBtn.classList.remove('record-btn-active');
                playBtn.disabled = false;
                isRecording = false;
                showNotification("Recording finished. Click 'Play My Recording' to listen.", 'info');
            };

            mediaRecorder.start();
            isRecording = true;
            
            playBtn.disabled = true;
            recordBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="5"/></svg> Stop Recording`;
            recordBtn.classList.add('record-btn-active');
            showNotification("Recording started...", 'info');

        } catch (err) {
            console.error('Recording failed:', err);
            showNotification(`Error accessing microphone: ${err.name}.`, 'error');
        }
    } else {
        // Stop recording
        mediaRecorder.stop();
    }
};

window.playRecording = () => {
    if (recordedAudioBlob) {
        const audioUrl = URL.createObjectURL(recordedAudioBlob);
        const audio = new Audio(audioUrl);
        audio.play();
        audio.onended = () => { URL.revokeObjectURL(audioUrl); };
    } else {
        showNotification("No recording available. Please record your voice first.", 'info');
    }
};


// --- UI & APPLICATION LOGIC ---

const showNotification = (message, type = 'info') => {
    const notification = document.getElementById('notification-box');
    notification.className = 'fixed top-4 right-4 z-50 p-3 rounded-xl text-sm transition-all duration-300 shadow-xl';
    notification.textContent = message;
    
    if (type === 'error') {
        notification.classList.add('bg-red-500', 'text-white');
    } else {
        notification.classList.add('bg-green-100', 'text-green-800');
    }
    
    notification.style.opacity = 1;
    setTimeout(() => {
        notification.style.opacity = 0;
    }, 3000);
};

window.changeView = (view) => {
    window.currentMode = view;
    window.isFlipped = false;
    
    const btnPractice = document.getElementById('btn-view-practice');
    const btnConversations = document.getElementById('btn-view-conversations');
    
    // Simple state change for navigation buttons
    const activeClass = 'bg-indigo-600 text-white';
    const inactiveClass = 'bg-white text-gray-700 hover:bg-gray-100';

    if (view === 'conversations') {
        window.currentConversationLevel = 1; // RESET LEVEL HERE
        window.currentConversationIndex = 0; // Index will be recalculated inside render
        btnConversations.className = btnConversations.className.replace(inactiveClass, activeClass);
        btnPractice.className = btnPractice.className.replace(activeClass, inactiveClass);
    } else {
        // Only update activeCardList if Lessons exist
        if (window.LESSONS && window.LESSONS.length > 0) {
             window.activeCardList = window.LESSONS[window.currentLessonIndex].cards;
        }
        btnPractice.className = btnPractice.className.replace(inactiveClass, activeClass);
        btnConversations.className = btnConversations.className.replace(activeClass, inactiveClass);
    }
    renderApp();
};

// --- FLASHCARD MODE FUNCTIONS ---

window.startSpeedReview = () => {
    if (!window.LESSONS || window.LESSONS.length === 0) {
        showNotification("No lessons loaded to start review.", 'error');
        return;
    }
    
    window.currentMode = 'review';
    let reviewCards = [];
    
    // FIX: Iterate with index to dynamically create progressKey and use 'name'
    window.LESSONS.forEach((lesson, index) => { 
        const progressKey = `L${index + 1}`;
        const multiplier = window.currentProgress[progressKey] ? 1 : 3;
        
        for (let i = 0; i < multiplier; i++) {
            if (lesson.cards && Array.isArray(lesson.cards)) {
                lesson.cards.forEach(card => {
                    // Use 'lesson.name' for the lesson title
                    reviewCards.push({...card, lessonTitle: lesson.name}); 
                });
            }
        }
    });
    
    // Shuffle the cards
    for (let i = reviewCards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [reviewCards[i], reviewCards[j]] = [reviewCards[j], reviewCards[i]];
    }
    
    window.activeCardList = reviewCards;
    window.currentCardIndex = 0;
    window.isFlipped = false;
    showNotification(`Starting Speed Review Mode with ${reviewCards.length} cards!`);
    renderApp();
};

window.selectLesson = (index) => {
    if (!window.LESSONS || window.LESSONS.length <= index) return;
    
    window.currentMode = 'practice';
    window.currentLessonIndex = index;
    window.currentCardIndex = 0;
    window.isFlipped = false;
    window.activeCardList = window.LESSONS[index].cards;
    renderApp();
};

window.flipCard = () => {
    if (window.currentMode === 'conversations') return;
    window.isFlipped = !window.isFlipped;
    const flipContainer = document.getElementById('flip-container');
    if (flipContainer) {
        flipContainer.classList.toggle('flipped', window.isFlipped);
    }
};

window.nextCard = () => {
    const list = window.activeCardList;
    if (window.currentCardIndex < list.length - 1) {
        window.currentCardIndex++;
        window.isFlipped = false;
        renderApp();
    } else {
        if (window.currentMode === 'practice') {
            const lesson = window.LESSONS[window.currentLessonIndex];
            // FIX: Dynamically create the progressKey 
            const progressKey = `L${window.currentLessonIndex + 1}`;
            
            markLessonComplete(progressKey);
            showNotification(`Lesson "${lesson.name}" completed!`); // Use lesson.name
            
            if (window.currentLessonIndex < window.LESSONS.length - 1) {
                window.selectLesson(window.currentLessonIndex + 1);
            } else {
                window.selectLesson(0); 
            }
        } else { // Review Mode finished
            showNotification(`Speed Review finished! You reviewed ${list.length} cards.`);
            window.selectLesson(0); 
        }
    }
};

window.prevCard = () => {
    if (window.currentCardIndex > 0) {
        window.currentCardIndex--;
        window.isFlipped = false;
        renderApp();
    }
};

const markLessonComplete = (key) => {
    if (!window.currentProgress[key]) {
        window.currentProgress[key] = true;
        saveProgress();
    }
};

// --- CONVERSATION MODE FUNCTIONS (UPDATED FOR LEVEL LOGIC) ---

// NEW FUNCTION: Select a level and find its first conversation
window.selectConversationLevel = (level) => {
    // 1. Set the new level
    window.currentConversationLevel = level;
    
    // 2. Find the first conversation belonging to this level
    // Assuming conversations have a 'level' property, defaulting to 1
    const firstConvIndex = window.CONVERSATIONS.findIndex(c => (c.level || 1) === level);
    
    // 3. Set the current index, default to 0 if none found (shouldn't happen with good data)
    window.currentConversationIndex = firstConvIndex !== -1 ? firstConvIndex : 0;
    
    renderApp();
};

window.nextConversation = () => {
    if (!window.CONVERSATIONS || window.CONVERSATIONS.length === 0) return;
    
    // Find all conversations for the current level
    const allConvs = window.CONVERSATIONS;
    
    // Find the index of the current conversation within the FULL list
    const currentConvIndexInFullList = window.currentConversationIndex;

    // Find the next conversation in the full list
    const nextConvIndexInFullList = currentConvIndexInFullList + 1;

    // Check if the next conversation exists
    if (nextConvIndexInFullList < allConvs.length) {
        const nextConv = allConvs[nextConvIndexInFullList];
        
        if ((nextConv.level || 1) === window.currentConversationLevel) {
            // Case 1: Next conversation is in the same level
            window.currentConversationIndex = nextConvIndexInFullList;
            renderApp();
        } else {
            // Case 2: Advance to the next level
            showNotification(`Moving to Conversation Level ${nextConv.level || 1}!`, 'info');
            window.selectConversationLevel(nextConv.level || 1); // selectConversationLevel handles setting the index
        }
    } else {
        // Case 3: Finished the last conversation of the highest level, loop to Level 1
        showNotification("All conversations completed! Looping to Level 1.", 'info');
        window.selectConversationLevel(1);
    }
};

window.prevConversation = () => {
    if (!window.CONVERSATIONS || window.CONVERSATIONS.length === 0) return;
    
    // Find the index of the current conversation within the FULL list
    const currentConvIndexInFullList = window.currentConversationIndex;
    
    // Check if there is a previous conversation
    if (currentConvIndexInFullList > 0) {
        const prevConvIndexInFullList = currentConvIndexInFullList - 1;
        const prevConv = window.CONVERSATIONS[prevConvIndexInFullList];
        
        if ((prevConv.level || 1) === window.currentConversationLevel) {
            // Case 1: Previous conversation is in the same level
            window.currentConversationIndex = prevConvIndexInFullList;
            renderApp();
        } else {
            // Case 2: Move back to the previous level's last conversation
            showNotification(`Moving back to Conversation Level ${prevConv.level || 1}!`, 'info');
            
            // The previous conversation in the full list is the LAST one of the previous level
            window.currentConversationIndex = prevConvIndexInFullList;
            window.currentConversationLevel = prevConv.level || 1;
            renderApp();
        }
    } else {
        // Case 3: At the first conversation of the app, move to the last conversation of the last level
        const allLevels = [...new Set(window.CONVERSATIONS.map(c => c.level || 1))].sort((a, b) => a - b);
        const lastLevel = allLevels[allLevels.length - 1];
        
        showNotification(`Looping to the last conversation of Level ${lastLevel}.`, 'info');
        
        // Find the index of the very last conversation in the full list
        const lastConvIndex = window.CONVERSATIONS.length - 1;
        
        window.currentConversationIndex = lastConvIndex;
        window.currentConversationLevel = lastLevel;
        renderApp();
    }
};

// --- MAIN RENDER FUNCTION ---

const renderApp = () => {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    const isConversation = window.currentMode === 'conversations';
    
    // FIX: Corrected logic here!
    document.getElementById('flashcard-container').style.display = isConversation ? 'none' : 'block';
    document.getElementById('conversation-container').style.display = isConversation ? 'block' : 'none';
    
    // Only show lesson navigation in 'practice' mode
    document.getElementById('lesson-nav-container').style.display = (window.currentMode === 'practice') ? 'block' : 'none';
    
    if (isConversation) {
        renderConversationPractice();
    } else {
        renderFlashcardView();
    }
};

const renderFlashcardView = () => {
    // --- SAFETY CHECK ---
    if (!window.LESSONS || window.LESSONS.length === 0) {
        document.getElementById('card-container').innerHTML = `<p class="text-center text-lg p-12 bg-white rounded-xl shadow-lg">Error: No lesson data found.</p>`;
        document.getElementById('lesson-nav').innerHTML = '<p class="text-gray-500">No lessons available.</p>';
        return;
    }
    
    const list = window.activeCardList;
    const card = list[window.currentCardIndex];
    const isReviewMode = window.currentMode === 'review';
    const navContainer = document.getElementById('lesson-nav');
    
    // 1. Render Mode Display 
    document.getElementById('current-mode-display').textContent = isReviewMode ? 'Speed Review' : 'Practice';
    document.getElementById('btn-start-review').style.display = isReviewMode ? 'none' : 'block';

    // 2. Render Lesson Navigation (FIXED MAPPING)
    if (window.currentMode === 'practice') {
        navContainer.innerHTML = window.LESSONS.map((l, index) => {
            // Map 'l.name' to lessonTitle and dynamically create progressKey
            const lessonTitle = l.name;
            const progressKey = `L${index + 1}`; 

            if (!l || !lessonTitle) {
                // If a lesson object is truly bad (null/missing name), render the error button
                return `<button class="p-3 text-sm font-medium rounded-xl bg-red-100 text-red-700">Error Lesson</button>`;
            }
            
            const isActive = index === window.currentLessonIndex;
            const isDone = window.currentProgress[progressKey];
            
            return `
                <button onclick="selectLesson(${index})"
                    class="p-3 text-sm font-medium rounded-xl transition duration-150 ease-in-out
                    ${isActive ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'}
                    ${isDone && !isActive ? 'border-2 border-green-500 text-green-700' : 'border border-gray-200'}
                    ">
                    ${lessonTitle}
                    ${isDone ? '<span class="ml-2">✅</span>' : ''}
                </button>
            `;
        }).join('');
    }

    if (!card) {
         document.getElementById('card-container').innerHTML = `<p class="text-center text-lg p-12 bg-white rounded-xl shadow-lg">No cards in this lesson.</p>`;
         document.getElementById('card-detail').innerHTML = '';
         document.getElementById('flashcard-recording-controls').innerHTML = '';
         document.getElementById('btn-prev').disabled = true;
         document.getElementById('btn-next').disabled = true;
         return;
    }

    // Prepare audio text (strip parenthetical notes)
    const audioText = card.french ? card.french.split('(')[0].trim() : '';
    
    // 3. Render Card Content
    const cardContainer = document.getElementById('card-container');
    cardContainer.innerHTML = `
        <div id="flip-container" class="flip-container h-80 w-full" onclick="flipCard()">
            <div class="front flex items-center justify-center p-6 absolute">
                <div class="text-center">
                    <p class="text-2xl font-semibold mb-2 text-gray-500">French</p>
                    <h2 class="text-5xl font-extrabold">${card.french || 'N/A'}</h2>
                    
                    <p class="text-2xl font-semibold mb-2 phonetic">${card.phonetic || ''}</p>
                    
                    ${card.verbContext ? `<p class="text-xl font-bold text-indigo-500 mb-6">${card.verbContext}</p>` : '<p class="mb-6 h-7"></p>'}

                    <button id="listen-button-main" onclick="event.stopPropagation(); handleListenClick('${audioText.replace(/'/g, "\\'")}')" 
                        class="listen-btn mt-6 flex items-center justify-center mx-auto text-lg hover:shadow-lg">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume-2 w-5 h-5 mr-2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                        </svg>
                        Listen
                    </button>
                    <p class="mt-4 text-sm text-gray-400">Click card to reveal English!</p>
                    ${isReviewMode ? `<p class="mt-2 text-xs text-indigo-400">From: ${card.lessonTitle}</p>` : ''}
                </div>
            </div>
            <div class="back flex items-center justify-center p-6 absolute">
                <div class="text-center">
                    <p class="text-2xl font-semibold mb-2 text-indigo-200">English Translation</p>
                    <h2 class="text-4xl font-extrabold">${card.english || 'N/A'}</h2>
                    
                    ${card.example ? `<p class="mt-4 text-xl font-medium text-indigo-300">${card.example}</p>` : ''}
                    
                    ${isReviewMode ? `<p class="mt-4 text-sm text-indigo-200">${card.lessonTitle}</p>` : ''}
                </div>
            </div>
        </div>
    `;
    if (window.isFlipped) {
        document.getElementById('flip-container').classList.add('flipped');
    }

    // 4. Render the Recording Controls (Duplicated structure but different IDs from conversation view)
    const recordingControls = document.getElementById('flashcard-recording-controls');
    if (recordingControls) {
        recordingControls.classList.remove('hidden');
        recordingControls.innerHTML = `
            <div class="flex justify-center space-x-4 p-4 bg-indigo-100 rounded-2xl shadow-inner my-6">
                <button id="record-btn-flashcard" onclick="toggleRecording()" class="action-btn flex items-center text-sm bg-red-500 hover:bg-red-600">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
                    Start Recording
                </button>
                <button id="play-btn-flashcard" onclick="playRecording()" disabled class="action-btn flex items-center text-sm bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400 disabled:cursor-not-allowed" style="box-shadow: 0 4px #4b5563;">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Play My Recording
                </button>
            </div>
        `;
    }
    
    // 5. Render Card Details and Navigation
    const cardDetail = document.getElementById('card-detail');
    const totalCards = list.length;
    const currentCardNumber = window.currentCardIndex + 1;
    
    let detailText = `Card: ${currentCardNumber} of ${totalCards}`;
    if (!isReviewMode) {
        const lesson = window.LESSONS[window.currentLessonIndex];
        // FIX: Dynamically create progressKey for completeness check
        const progressKey = `L${window.currentLessonIndex + 1}`;
        const isCompleted = window.currentProgress[progressKey];
        detailText = `Lesson: <span class="font-semibold">${lesson.name}</span> | ${detailText} ${isCompleted ? ' (COMPLETED)' : ''}`;
    } else {
         detailText = `Mode: <span class="font-semibold">Speed Review</span> | ${detailText}`;
    }

    cardDetail.innerHTML = `<p class="text-sm text-gray-500 mt-4">${detailText}</p>`;

    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const isLastCard = window.currentCardIndex === totalCards - 1;

    btnPrev.disabled = window.currentCardIndex === 0;

    if (isLastCard) {
        btnNext.textContent = isReviewMode ? "Finish Review" : "Mark Complete & Next Lesson";
        btnNext.className = `p-3 rounded-xl font-semibold transition duration-150 bg-green-600 text-white hover:bg-green-700`;
    } else {
        btnNext.textContent = "Next Card >";
        btnNext.className = `p-3 rounded-xl font-semibold transition duration-150 bg-indigo-600 text-white hover:bg-indigo-700`;
    }
    btnPrev.className = `p-3 rounded-xl font-semibold transition duration-150 ${window.currentCardIndex === 0 ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-700 hover:bg-gray-400'}`;
};

const renderConversationPractice = () => {
    // --- SAFETY CHECK ---
    if (!window.CONVERSATIONS || window.CONVERSATIONS.length === 0) {
        const convContainer = document.getElementById('conversation-container');
        convContainer.innerHTML = `<p class="text-center text-lg p-12 bg-white rounded-xl shadow-lg">Error: No conversation data found.</p>`;
        document.getElementById('current-mode-display').textContent = 'Conversations';
        return;
    }
    
    // 1. Determine Levels and Filter Conversations
    const uniqueLevels = [...new Set(window.CONVERSATIONS.map(c => c.level || 1))].sort((a, b) => a - b);
    const levelConvs = window.CONVERSATIONS.filter(c => (c.level || 1) === window.currentConversationLevel);

    // Get the current conversation based on the index
    const currentConv = window.CONVERSATIONS[window.currentConversationIndex];
    
    // Find the index of the current conversation within the filtered level list
    const currentConvIndexInLevel = levelConvs.findIndex(c => 
        c.topic === currentConv.topic && (c.level || 1) === window.currentConversationLevel
    );

    const convContainer = document.getElementById('conversation-container');

    document.getElementById('current-mode-display').textContent = 'Conversations';
    
    // 2. Render Level Navigation Bar
    const levelNavHtml = uniqueLevels.map(level => {
        const isActive = level === window.currentConversationLevel;
        return `
            <button onclick="selectConversationLevel(${level})"
                class="p-3 text-sm font-medium rounded-xl transition duration-150 ease-in-out
                ${isActive ? 'bg-purple-600 text-white shadow-md' : 'bg-white text-gray-700 hover:bg-purple-50 hover:text-purple-600'}
                border border-gray-200">
                Level ${level}
            </button>
        `;
    }).join('');

    // Conversation HTML starts with Level Nav and then the content
    convContainer.innerHTML = `
        <div class="mb-6 flex flex-wrap gap-3 p-4 bg-purple-100 rounded-2xl shadow-inner">
            <h4 class="text-md font-bold text-purple-700 mr-2 self-center">Select Level:</h4>
            ${levelNavHtml}
        </div>

        <div class="bg-white rounded-3xl shadow-2xl p-6 mb-6">
            <div class="text-center pb-4 border-b border-gray-100">
                <p class="text-xl font-bold text-indigo-600">Topic: ${currentConv.topic}</p>
                <p class="text-sm text-gray-500">
                    Scenario ${currentConvIndexInLevel + 1} of ${levelConvs.length} (Level ${window.currentConversationLevel})
                </p>
            </div>

            <div class="mt-6 p-4 bg-indigo-50 rounded-xl border border-indigo-200 shadow-inner">
                <p class="text-sm font-semibold text-indigo-700 mb-2">Question:</p>
                <h3 class="text-3xl font-extrabold text-indigo-900 mb-2">${currentConv.question}</h3>
                
                <p class="text-xl italic text-indigo-700 font-medium mb-3">${currentConv.englishQuestion}</p>
                
                <p class="text-lg font-semibold phonetic">${currentConv.answers[0].phonetic.split('/').slice(0, 2).join('/').replace(',', '')}...</p>
                <button id="listen-button-q" onclick="handleListenClick('${currentConv.question.replace(/'/g, "\\'")}')" 
                    class="listen-btn mt-3 flex items-center justify-center text-sm">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                    Listen Question
                </button>
            </div>

            <h4 class="text-xl font-bold text-gray-700 mt-8 mb-4">Choose and Practice Your Answer:</h4>
            
            <div class="p-4 bg-white rounded-xl border border-gray-300 shadow-lg mb-4">
                <p class="text-2xl font-medium text-gray-800">${currentConv.answers[0].text}</p>
                
                <p class="text-base italic text-gray-500 mb-2">${currentConv.answers[0].englishText}</p>
                
                <p class="text-sm font-semibold phonetic mb-3">${currentConv.answers[0].phonetic}</p>
                <button id="listen-button-a1" onclick="handleListenClick('${currentConv.answers[0].text.replace(/'/g, "\\'")}')" 
                    class="listen-btn flex items-center justify-center text-sm px-3 py-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                    Listen Sample
                </button>
            </div>

            <div class="p-4 bg-white rounded-xl border border-gray-300 shadow-lg">
                <p class="text-2xl font-medium text-gray-800">${currentConv.answers[1].text}</p>
                
                <p class="text-base italic text-gray-500 mb-2">${currentConv.answers[1].englishText}</p>
                
                <p class="text-sm font-semibold phonetic mb-3">${currentConv.answers[1].phonetic}</p>
                <button id="listen-button-a2" onclick="handleListenClick('${currentConv.answers[1].text.replace(/'/g, "\\'")}')" 
                    class="listen-btn flex items-center justify-center text-sm px-3 py-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                    Listen Sample
                </button>
            </div>
        </div>

        <div class="flex justify-center space-x-4 p-4 bg-indigo-100 rounded-2xl shadow-inner">
            <button id="record-btn" onclick="toggleRecording()" class="action-btn flex items-center text-sm bg-red-500 hover:bg-red-600">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
                Start Recording
            </button>
            <button id="play-btn" onclick="playRecording()" disabled class="action-btn flex items-center text-sm bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400 disabled:cursor-not-allowed" style="box-shadow: 0 4px #4b5563;">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Play My Recording
            </button>
        </div>

        <div class="flex justify-between items-center mt-6">
            <button onclick="prevConversation()" class="p-3 rounded-xl font-semibold transition duration-150 bg-gray-300 text-gray-700 hover:bg-gray-400">
                &lt; Previous
            </button>
            <button onclick="nextConversation()" class="p-3 rounded-xl font-semibold transition duration-150 bg-indigo-600 text-white hover:bg-indigo-700">
                Next &gt;
            </button>
        </div>
    `;
};

// --- INITIALIZATION ---

// Call the initialization function directly
initFirebase();