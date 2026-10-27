// =====================================================================
        // KONFIGURASI AI
        // Isi dengan API key Google AI Studio Anda sendiri.
        // PERINGATAN: key di kode front-end bisa dilihat siapa pun yang membuka
        // halaman ini. Batasi key di Google AI Studio (HTTP referrer + kuota),
        // atau pindahkan panggilan AI ke server/proxy untuk produksi.
        // =====================================================================
        const GEMINI_API_KEY = "via-proxy"; // key asli disimpan di Cloudflare Worker, bukan di file ini
        const GEMINI_PROXY = "https://ohealthy-ai.aimotions99.workers.dev"; // contoh: https://ohealthy-ai.namaanda.workers.dev

        // ---------- Global State ----------
        let currentUser = null;
        let tempPendingUser = null;
        let pendingLoginEmail = null; // user yang ditolak login (menunggu ACC), untuk chat bantuan
        let dbData = emptyData();
        let currentImageBase64 = null;
        let lastAIAnalysis = null;
        let weightChartInstance = null;
        let calorieChartInstance = null;

        const motivationalQuotes = [
            { title: "Kesehatan adalah Investasi Terbaik", text: "Investasi terbaik yang bisa kamu lakukan adalah pada kesehatan tubuh dan pikiranmu sendiri." },
            { title: "Konsistensi Kunci Keberhasilan", text: "Perubahan besar tidak terjadi dalam semalam. Pertahankan kebiasaan kecil sehat setiap hari!" },
            { title: "Tubuhmu Mendengar Pikiranmu", text: "Tetaplah positif, konsumsi makanan bernutrisi tinggi, dan sayangi dirimu hari ini." },
            { title: "Energi untuk Impianmu", text: "Makanan adalah bahan bakar. Beri tubuhmu bahan bakar terbaik untuk mewujudkan mimpimu!" }
        ];

        // ---------- Utilities ----------
        function esc(s) {
            return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        // Tanggal LOKAL (bukan UTC) agar tidak meleset sehari pada dini hari WIB
        function dateStr(d = new Date()) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
        function timeStr() {
            return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        // Penyimpanan aman: tidak menimpa data jika JSON rusak (disalin dulu ke key __corrupt)
        const LS = {
            get(key, fallback) {
                let raw = null;
                try {
                    raw = localStorage.getItem(key);
                    return raw ? JSON.parse(raw) : fallback;
                } catch (e) {
                    console.error('Gagal membaca', key, e);
                    try { if (raw) localStorage.setItem(key + '__corrupt', raw); } catch (_) {}
                    return fallback;
                }
            },
            set(key, val) {
                try {
                    localStorage.setItem(key, JSON.stringify(val));
                    cloudPush(key, val);
                    return true;
                } catch (e) {
                    console.error('Gagal menyimpan', key, e);
                    showToast('Gagal menyimpan data (penyimpanan browser penuh atau diblokir).', 'error');
                    return false;
                }
            }
        };

        // =====================================================================
        // SINKRONISASI CLOUD (Firebase Firestore) - agar akun, ACC, data & chat
        // sama di semua perangkat. Isi konfigurasi di bawah (lihat panduan).
        // =====================================================================
        const FIREBASE_CONFIG = {
            apiKey: "AIzaSyDTPFlCEsMlZBZFVj7HfSI4qeJ8nK5StJo",
            authDomain: "o-healthy-4b945.firebaseapp.com",
            projectId: "o-healthy-4b945",
            appId: "1:759764595046:web:d682ce2774d780e57c98a7"
        };
        let fdb = null;
        try {
            if (window.firebase && FIREBASE_CONFIG.projectId.indexOf('ISI_') !== 0) {
                firebase.initializeApp(FIREBASE_CONFIG);
                fdb = firebase.firestore();
            } else { console.warn('Firebase belum dikonfigurasi: data hanya tersimpan di perangkat ini.'); }
        } catch (e) { console.error('Firebase gagal:', e); }

        const ek = e => encodeURIComponent(e);
        function cloudCol(key) {
            if (key.startsWith('ohealthy_data_')) return ['userdata', ek(key.slice(14))];
            if (key.startsWith('ohealthy_chat_')) return ['chats', ek(key.slice(14))];
            return null;
        }
        function cloudErr(e) { console.error(e); showToast('Gagal sinkron ke server. Periksa koneksi.', 'error'); }
        function cloudPush(key, val) {
            const c = cloudCol(key);
            if (fdb && c) fdb.collection(c[0]).doc(c[1]).set({ v: JSON.stringify(val), t: Date.now() }).catch(cloudErr);
        }
        async function cloudPull(key) {
            const c = cloudCol(key);
            if (!fdb || !c) return;
            try { const d = await fdb.collection(c[0]).doc(c[1]).get(); if (d.exists) localStorage.setItem(key, d.data().v); }
            catch (e) { console.error(e); }
        }
        function mergeUser(u) {
            const us = LS.get('ohealthy_users', []);
            const i = us.findIndex(x => normEmail(x.email) === normEmail(u.email));
            if (i >= 0) us[i] = u; else us.push(u);
            localStorage.setItem('ohealthy_users', JSON.stringify(us));
        }
        async function pullUser(email) {
            if (!fdb) return;
            try { const d = await fdb.collection('users').doc(ek(email)).get(); if (d.exists) mergeUser(d.data()); }
            catch (e) { console.error(e); }
        }
        async function pullUserByName(name) {
            if (!fdb) return;
            try { const q = await fdb.collection('users').where('name', '==', name).limit(1).get(); q.forEach(d => mergeUser(d.data())); }
            catch (e) { console.error(e); }
        }

        function getUsers() { return LS.get('ohealthy_users', []); }
        function saveUsers(users) {
            const old = getUsers();
            const ok = LS.set('ohealthy_users', users);
            if (ok && fdb) {
                users.forEach(u => {
                    const o = old.find(x => x.email === u.email);
                    if (!o || JSON.stringify(o) !== JSON.stringify(u)) fdb.collection('users').doc(ek(u.email)).set(u).catch(cloudErr);
                });
                old.forEach(o => {
                    if (!users.find(u => u.email === o.email)) ['users', 'userdata', 'chats'].forEach(c => fdb.collection(c).doc(ek(o.email)).delete().catch(cloudErr));
                });
            }
            return ok;
        }

        // Admin: pantau semua user & chat secara realtime (HP & laptop selalu sama)
        let adminUnsubs = [], chatUnsub = null, chatWatchKey = null;
        function stopSync() {
            adminUnsubs.forEach(f => f()); adminUnsubs = [];
            if (chatUnsub) chatUnsub(); chatUnsub = null; chatWatchKey = null;
        }
        function adminVisible() { return !document.getElementById('admin-dashboard-screen').classList.contains('hidden'); }
        function startAdminSync() {
            if (!fdb || adminUnsubs.length) return;
            let first = true;
            adminUnsubs.push(fdb.collection('users').onSnapshot(snap => {
                const list = snap.docs.map(d => d.data());
                if (first) {
                    first = false;
                    // Sekali per perangkat: unggah akun lama yang hanya ada di browser ini
                    if (!localStorage.getItem('ohealthy_migrated')) {
                        localStorage.setItem('ohealthy_migrated', '1');
                        const have = new Set(list.map(u => u.email));
                        let moved = false;
                        getUsers().forEach(u => {
                            if (have.has(u.email)) return;
                            moved = true;
                            fdb.collection('users').doc(ek(u.email)).set(u).catch(cloudErr);
                            ['ohealthy_data_', 'ohealthy_chat_'].forEach(pre => {
                                const raw = localStorage.getItem(pre + u.email), c = cloudCol(pre + u.email);
                                if (raw) fdb.collection(c[0]).doc(c[1]).set({ v: raw, t: Date.now() }).catch(cloudErr);
                            });
                        });
                        if (moved) return; // snapshot berikutnya sudah memuat akun hasil unggahan
                    }
                }
                localStorage.setItem('ohealthy_users', JSON.stringify(list));
                if (adminVisible()) renderAdminTable();
            }, e => console.error(e)));
            adminUnsubs.push(fdb.collection('chats').onSnapshot(snap => {
                let changed = false;
                snap.docChanges().forEach(ch => {
                    if (ch.doc.metadata.hasPendingWrites || ch.type === 'removed') return;
                    localStorage.setItem('ohealthy_chat_' + decodeURIComponent(ch.doc.id), ch.doc.data().v);
                    changed = true;
                });
                const ae = document.activeElement;
                const typing = ae && ae.id && ae.id.indexOf('admin-reply-') === 0;
                if (changed && adminVisible() && !typing) renderAdminChatsList();
            }, e => console.error(e)));
        }
        // User: chat dengan admin tampil realtime
        function watchChat(key) {
            if (!fdb || key === chatWatchKey) return;
            if (chatUnsub) chatUnsub();
            chatWatchKey = key; chatUnsub = null;
            const c = cloudCol(key);
            if (!c || c[1] === 'guest') return;
            chatUnsub = fdb.collection(c[0]).doc(c[1]).onSnapshot(d => {
                if (d.exists && !d.metadata.hasPendingWrites) { localStorage.setItem(key, d.data().v); loadUserChatMessages(); }
            }, e => console.error(e));
        }
        function normEmail(s) { return String(s || '').trim().toLowerCase(); }

        function emptyData() {
            return {
                profile: { age: 25, gender: 'male', weight: 65, height: 170, activity: 1.55, targetCalories: 2000, idealMin: '53.5', idealMax: '72.0', devine: '63.5' },
                metrics: [], journal: [], fluids: []
            };
        }

        // Perhitungan kalori & berat ideal (satu sumber untuk pendaftaran & menu Saya)
        function calcProfile(age, gender, weight, height, activity) {
            const bmr = (10 * weight) + (6.25 * height) - (5 * age) + (gender === 'male' ? 5 : -161);
            const hm = height / 100;
            return {
                targetCalories: Math.round(bmr * activity),
                bmi: (weight / (hm * hm)).toFixed(1),
                idealMin: (18.5 * hm * hm).toFixed(1),
                idealMax: (24.9 * hm * hm).toFixed(1),
                devine: ((gender === 'male' ? 50 : 45.5) + 0.9 * (height - 152.4)).toFixed(1)
            };
        }
        function bmiStatus(bmi) {
            if (bmi < 18.5) return 'Kurus (Underweight)';
            if (bmi < 25) return 'Normal';
            if (bmi < 30) return 'Kelebihan (Overweight)';
            return 'Obesitas';
        }

        function showToast(message, type = 'success') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            const bg = type === 'success' ? 'bg-emerald-600 text-white' : (type === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-800 text-white');
            toast.className = `${bg} px-4 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center space-x-2 pointer-events-auto transition transform translate-y-2 opacity-0 duration-300 max-w-xs`;
            const icon = type === 'success' ? 'fa-circle-check' : (type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info');
            toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${esc(message)}</span>`;
            container.appendChild(toast);
            setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
            setTimeout(() => {
                toast.classList.add('translate-y-2', 'opacity-0');
                setTimeout(() => toast.remove(), 300);
            }, 4000);
        }

        function togglePassword(inputId, btn) {
            const input = document.getElementById(inputId);
            const icon = btn.querySelector('i');
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            icon.className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        }

        // ---------- Init ----------
        window.onload = async function () {
            // Minta browser agar data tidak dihapus otomatis saat penyimpanan menipis
            if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }

            document.getElementById('metric-date').value = dateStr();
            resetDateFilter(false);

            await pullUser('admin');
            let users = getUsers();
            if (!users.find(u => u.email === 'admin')) {
                users.push({ name: 'Super Admin', email: 'admin', password: 'adminpassword', role: 'admin', status: 'approved' });
                saveUsers(users);
            }

            // Pulihkan sesi, tapi validasi ulang terhadap daftar user terbaru
            const sess = LS.get('ohealthy_current_user', null);
            if (sess && sess.email) {
                await pullUser(sess.email);
                await cloudPull('ohealthy_data_' + sess.email);
                await cloudPull('ohealthy_chat_' + sess.email);
                const u = getUsers().find(x => x.email === sess.email);
                if (u && (u.role === 'admin' || u.status === 'approved')) {
                    currentUser = u;
                    if (u.role === 'admin') showAdminDashboard();
                    else { loadUserData(); showDashboard(); }
                } else {
                    localStorage.removeItem('ohealthy_current_user');
                }
            }
        };

        // ---------- Motivation ----------
        function showMotivationPopup() {
            const q = motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];
            document.getElementById('motivation-title').innerText = q.title;
            document.getElementById('motivation-text').innerText = `"${q.text}"`;
            document.getElementById('motivation-modal').classList.remove('hidden');
        }
        function closeMotivationModal() { document.getElementById('motivation-modal').classList.add('hidden'); }

        // ---------- Auth ----------
        function switchAuthTab(tab) {
            const loginBtn = document.getElementById('tab-login-btn');
            const regBtn = document.getElementById('tab-register-btn');
            const loginForm = document.getElementById('login-form');
            const regForm = document.getElementById('register-form');
            const on = "flex-1 py-2 text-sm font-semibold rounded-lg bg-white text-slate-800 shadow-sm transition";
            const off = "flex-1 py-2 text-sm font-semibold rounded-lg text-slate-500 hover:text-slate-800 transition";
            if (tab === 'login') {
                loginBtn.className = on; regBtn.className = off;
                loginForm.classList.remove('hidden'); regForm.classList.add('hidden');
            } else {
                regBtn.className = on; loginBtn.className = off;
                regForm.classList.remove('hidden'); loginForm.classList.add('hidden');
            }
        }

        async function handleRegister(e) {
            e.preventDefault();
            const name = document.getElementById('reg-name').value.trim();
            const email = normEmail(document.getElementById('reg-email').value);
            const password = document.getElementById('reg-password').value;

            await pullUser(email);
            if (getUsers().find(u => normEmail(u.email) === email)) {
                showToast('Email sudah terdaftar. Silakan masuk.', 'error');
                return;
            }
            tempPendingUser = { name, email, password, role: 'user', status: 'pending' };
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('profiling-screen').classList.remove('hidden');
        }

        function cancelProfiling() {
            tempPendingUser = null;
            document.getElementById('profiling-screen').classList.add('hidden');
            document.getElementById('auth-screen').classList.remove('hidden');
        }

        function handleSaveProfiling(e) {
            e.preventDefault();
            if (!tempPendingUser) { cancelProfiling(); return; }
            const age = parseInt(document.getElementById('pro-age').value);
            const gender = document.getElementById('pro-gender').value;
            const weight = parseFloat(document.getElementById('pro-weight').value);
            const height = parseFloat(document.getElementById('pro-height').value);
            const activity = parseFloat(document.getElementById('pro-activity').value);

            const calc = calcProfile(age, gender, weight, height, activity);
            tempPendingUser.profile = {
                age, gender, weight, height, activity,
                targetCalories: calc.targetCalories, idealMin: calc.idealMin, idealMax: calc.idealMax, devine: calc.devine
            };

            const users = getUsers();
            if (users.find(u => normEmail(u.email) === tempPendingUser.email)) {
                showToast('Email sudah terdaftar. Silakan masuk.', 'error');
                cancelProfiling();
                return;
            }
            users.push(tempPendingUser);
            if (!saveUsers(users)) return;

            const initialData = {
                profile: tempPendingUser.profile,
                metrics: [{ id: Date.now(), date: dateStr(), weight, height, bmi: calc.bmi }],
                journal: [], fluids: []
            };
            LS.set(`ohealthy_data_${tempPendingUser.email}`, initialData);

            tempPendingUser = null;
            document.getElementById('profiling-screen').classList.add('hidden');
            document.getElementById('auth-screen').classList.remove('hidden');
            switchAuthTab('login');
            showToast('Pendaftaran berhasil! Silakan masuk menggunakan akun Anda.', 'success');
        }

        async function handleLogin(e) {
            e.preventDefault();
            const identifier = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;
            const idLower = identifier.toLowerCase();

            await pullUser(idLower);
            if (!getUsers().some(u => String(u.email).toLowerCase() === idLower)) await pullUserByName(identifier);
            const found = getUsers().find(u =>
                (String(u.email).toLowerCase() === idLower || u.name === identifier) && u.password === password
            );

            if (!found) { showToast('Email atau password salah!', 'error'); return; }

            if (found.role !== 'admin' && found.status !== 'approved') {
                pendingLoginEmail = found.email;
                await cloudPull('ohealthy_chat_' + found.email);
                showToast('Akses Anda ditolak. Mohon hubungi Admin untuk konfirmasi pembelian.', 'error');
                document.getElementById('chat-widget-container').classList.remove('hidden');
                loadUserChatMessages();
                return;
            }

            pendingLoginEmail = null;
            currentUser = found;
            await cloudPull('ohealthy_data_' + found.email);
            await cloudPull('ohealthy_chat_' + found.email);
            LS.set('ohealthy_current_user', { email: found.email });

            if (found.role === 'admin') {
                showAdminDashboard();
                showToast('Berhasil masuk ke Portal Admin.');
            } else {
                loadUserData();
                showDashboard();
                showToast('Berhasil masuk ke akun.');
                showMotivationPopup();
            }
            document.getElementById('login-form').reset();
        }

        function handleLogout() {
            currentUser = null;
            pendingLoginEmail = null;
            localStorage.removeItem('ohealthy_current_user');
            stopSync();
            document.getElementById('auth-screen').classList.remove('hidden');
            document.getElementById('dashboard-screen').classList.add('hidden');
            document.getElementById('admin-dashboard-screen').classList.add('hidden');
            document.getElementById('chat-widget-container').classList.add('hidden');
            document.getElementById('chat-window').classList.add('hidden');
            resetScanner();
            showToast('Berhasil keluar.', 'info');
        }

        function showDashboard() {
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('profiling-screen').classList.add('hidden');
            document.getElementById('admin-dashboard-screen').classList.add('hidden');
            document.getElementById('dashboard-screen').classList.remove('hidden');
            document.getElementById('chat-widget-container').classList.remove('hidden');
            document.getElementById('user-display-name').innerText = currentUser.name;
            switchTab('dashboard');
            renderAll();
            fillProfileForm();
            loadUserChatMessages();
        }

        function showAdminDashboard() {
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('profiling-screen').classList.add('hidden');
            document.getElementById('dashboard-screen').classList.add('hidden');
            document.getElementById('chat-widget-container').classList.add('hidden');
            document.getElementById('admin-dashboard-screen').classList.remove('hidden');
            startAdminSync();
            renderAdminTable();
            renderAdminChatsList();
        }

        // ---------- Admin ----------
        function switchAdminTab(tab) {
            const usersSec = document.getElementById('admin-section-users');
            const chatsSec = document.getElementById('admin-section-chats');
            const usersBtn = document.getElementById('admin-tab-users-btn');
            const chatsBtn = document.getElementById('admin-tab-chats-btn');
            if (tab === 'users') {
                usersSec.classList.remove('hidden'); chatsSec.classList.add('hidden');
                usersBtn.className = "px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold transition shadow-sm";
                chatsBtn.className = "px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl text-xs font-bold transition flex items-center space-x-2";
            } else {
                usersSec.classList.add('hidden'); chatsSec.classList.remove('hidden');
                chatsBtn.className = "px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold transition shadow-sm flex items-center space-x-2";
                usersBtn.className = "px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl text-xs font-bold transition";
                renderAdminChatsList();
            }
        }

        function renderAdminTable() {
            const tbody = document.getElementById('admin-users-table-body');
            const regular = getUsers().filter(u => u.role !== 'admin');
            if (regular.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-slate-400 italic">Belum ada user terdaftar.</td></tr>`;
                return;
            }
            tbody.innerHTML = regular.map(u => `
                <tr class="hover:bg-slate-50 transition">
                    <td class="py-2.5 px-3 md:py-3 md:px-4 font-bold text-slate-900">${esc(u.name)}</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-slate-600">${esc(u.email)}</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4">
                        <span class="px-2.5 py-1 rounded-full text-xs font-semibold ${u.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">
                            ${u.status === 'approved' ? 'DI-ACC (Aktif)' : 'Menunggu ACC'}
                        </span>
                    </td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-right space-x-2">
                        ${u.status !== 'approved'
                            ? `<button onclick="changeUserStatus('${esc(u.email)}', 'approved')" class="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition">ACC Akses</button>`
                            : `<button onclick="changeUserStatus('${esc(u.email)}', 'pending')" class="px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-semibold transition">Cabut Akses</button>`}
                        <button onclick="deleteUser('${esc(u.email)}')" class="px-3 py-1 bg-rose-500 hover:bg-rose-600 text-white rounded-lg text-xs font-semibold transition"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>`).join('');
        }

        function changeUserStatus(email, newStatus) {
            const users = getUsers().map(u => { if (u.email === email) u.status = newStatus; return u; });
            saveUsers(users);
            renderAdminTable();
            showToast(`Status user ${email} berhasil diubah.`);
        }

        function deleteUser(email) {
            if (!confirm(`Hapus user ${email} beserta seluruh datanya? Tindakan ini tidak bisa dibatalkan.`)) return;
            saveUsers(getUsers().filter(u => u.email !== email));
            localStorage.removeItem(`ohealthy_data_${email}`);
            localStorage.removeItem(`ohealthy_chat_${email}`);
            renderAdminTable();
            showToast('User berhasil dihapus.', 'info');
        }

        // ---------- Chat ----------
        function toggleChatBox() {
            const win = document.getElementById('chat-window');
            win.classList.toggle('hidden');
            if (!win.classList.contains('hidden')) {
                loadUserChatMessages();
                document.getElementById('user-chat-unread-dot').classList.add('hidden');
            }
        }

        function getChatKey() {
            const email = currentUser ? currentUser.email : (pendingLoginEmail || (tempPendingUser ? tempPendingUser.email : 'guest'));
            return `ohealthy_chat_${email}`;
        }

        function loadUserChatMessages() {
            watchChat(getChatKey());
            const msgs = LS.get(getChatKey(), []);
            const body = document.getElementById('chat-messages-body');
            if (msgs.length === 0) {
                body.innerHTML = `
                    <div class="text-center py-6 text-slate-400 space-y-1">
                        <i class="fa-solid fa-comments text-2xl text-emerald-500"></i>
                        <p class="text-xs font-medium">Halo! Ada kendala aktivasi atau konfirmasi pembelian? Kirim pesan di sini.</p>
                    </div>`;
                return;
            }
            body.innerHTML = msgs.map(m => `
                <div class="flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}">
                    <div class="max-w-[80%] rounded-2xl px-4 py-2 text-xs shadow-sm ${m.sender === 'user' ? 'bg-emerald-600 text-white rounded-br-none' : 'bg-white text-slate-800 border border-slate-200 rounded-bl-none'}">
                        ${m.text ? `<p>${esc(m.text)}</p>` : ''}
                        ${m.image ? `<img src="${m.image}" class="mt-2 rounded-xl max-h-48 object-cover">` : ''}
                        <span class="block text-[9px] mt-1 opacity-70 text-right">${esc(m.time)}</span>
                    </div>
                </div>`).join('');
            body.scrollTop = body.scrollHeight;
        }

        function sendUserChatMessage(customImg = null, customText = null) {
            const textInput = document.getElementById('chat-input-text');
            const text = customText || textInput.value.trim();
            if (!text && !customImg) return;

            const chatKey = getChatKey();
            const msgs = LS.get(chatKey, []);
            msgs.push({ sender: 'user', text, image: customImg, time: timeStr(), unreadByAdmin: true });
            LS.set(chatKey, msgs);
            if (!customText) textInput.value = '';
            loadUserChatMessages();
        }

        function handleChatImageUpload(e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = evt => {
                // kompres agar tidak memenuhi penyimpanan
                compressImage(evt.target.result, 800, 0.7).then(img => sendUserChatMessage(img, "Mengirim Bukti Gambar"));
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        }

        function renderAdminChatsList() {
            const regular = getUsers().filter(u => u.role !== 'admin');
            const container = document.getElementById('admin-chats-list');
            let html = '', hasAny = false, anyUnread = false;

            regular.forEach(u => {
                const msgs = LS.get(`ohealthy_chat_${u.email}`, []);
                if (msgs.length === 0) return;
                hasAny = true;
                if (msgs.some(m => m.sender === 'user' && m.unreadByAdmin)) anyUnread = true;

                html += `
                <div class="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                    <div class="flex items-center justify-between border-b border-slate-200 pb-2">
                        <div class="flex items-center space-x-2">
                            <div class="w-8 h-8 bg-indigo-100 text-indigo-700 rounded-full flex items-center justify-center font-bold text-xs">${esc(u.name.charAt(0))}</div>
                            <div>
                                <h4 class="font-bold text-slate-900 text-sm">${esc(u.name)}</h4>
                                <p class="text-[11px] text-slate-500">${esc(u.email)} • Status: <span class="font-semibold ${u.status === 'approved' ? 'text-emerald-600' : 'text-amber-600'}">${esc(u.status)}</span></p>
                            </div>
                        </div>
                        ${u.status !== 'approved' ? `<button onclick="changeUserStatus('${esc(u.email)}', 'approved'); renderAdminChatsList();" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm">ACC Akses User Ini</button>` : ''}
                    </div>
                    <div class="max-h-60 overflow-y-auto space-y-2 p-2 bg-white rounded-xl border border-slate-100">
                        ${msgs.map(m => `
                            <div class="flex flex-col ${m.sender === 'admin' ? 'items-end' : 'items-start'}">
                                <div class="max-w-[75%] rounded-xl px-3 py-2 text-xs ${m.sender === 'admin' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-800'}">
                                    ${m.text ? `<p>${esc(m.text)}</p>` : ''}
                                    ${m.image ? `<img src="${m.image}" class="mt-2 rounded-lg max-h-36 object-cover">` : ''}
                                    <span class="block text-[8px] mt-0.5 opacity-70 text-right">${esc(m.time)}</span>
                                </div>
                            </div>`).join('')}
                    </div>
                    <div class="flex space-x-2">
                        <input type="text" id="admin-reply-${esc(u.email)}" onkeypress="if(event.key==='Enter') sendAdminReply('${esc(u.email)}')" class="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Balas pesan user...">
                        <button onclick="sendAdminReply('${esc(u.email)}')" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold">Kirim Balasan</button>
                    </div>
                </div>`;
            });

            container.innerHTML = hasAny ? html : `<p class="text-slate-400 italic text-sm">Belum ada pesan chat masuk dari pembeli.</p>`;
            document.getElementById('admin-chat-badge').classList.toggle('hidden', !anyUnread);
        }

        function sendAdminReply(userEmail) {
            const input = document.getElementById(`admin-reply-${userEmail}`);
            const text = input.value.trim();
            if (!text) return;
            const chatKey = `ohealthy_chat_${userEmail}`;
            const msgs = LS.get(chatKey, []);
            msgs.forEach(m => m.unreadByAdmin = false);
            msgs.push({ sender: 'admin', text, image: null, time: timeStr() });
            LS.set(chatKey, msgs);
            input.value = '';
            renderAdminChatsList();
            showToast('Balasan admin terkirim.');
        }

        // ---------- User data ----------
        function loadUserData() {
            const raw = LS.get(`ohealthy_data_${currentUser.email}`, null);
            const base = emptyData();
            if (raw) {
                dbData = {
                    profile: Object.assign(base.profile, raw.profile || {}),
                    metrics: Array.isArray(raw.metrics) ? raw.metrics : [],
                    journal: Array.isArray(raw.journal) ? raw.journal : [],
                    fluids: Array.isArray(raw.fluids) ? raw.fluids : []
                };
            } else {
                // Jika data hilang tetapi akun ada, ambil profil dari record user
                if (currentUser.profile) base.profile = Object.assign(base.profile, currentUser.profile);
                dbData = base;
            }
        }

        function saveUserData() { return LS.set(`ohealthy_data_${currentUser.email}`, dbData); }

        function switchTab(tabId) {
            const tabs = ['dashboard', 'ai-scanner', 'catalog', 'fluids', 'metrics', 'journal', 'profile'];
            tabs.forEach(t => {
                const el = document.getElementById(`tab-content-${t}`);
                const navEl = document.getElementById(`nav-${t}`);
                if (t === tabId) {
                    el.classList.remove('hidden');
                    navEl.className = "flex flex-col md:flex-row items-center justify-center md:justify-start gap-0.5 md:gap-0 md:space-x-3 flex-1 min-w-0 md:flex-none md:w-full p-2 md:p-3 rounded-xl font-semibold text-[10px] md:text-sm leading-tight transition bg-emerald-50 text-emerald-700";
                    if (t === 'dashboard') setTimeout(() => renderCharts(), 100);
                    if (t === 'profile') fillProfileForm();
                    if (t === 'catalog') renderCatalog();
                } else {
                    el.classList.add('hidden');
                    navEl.className = "flex flex-col md:flex-row items-center justify-center md:justify-start gap-0.5 md:gap-0 md:space-x-3 flex-1 min-w-0 md:flex-none md:w-full p-2 md:p-3 rounded-xl font-semibold text-[10px] md:text-sm leading-tight transition text-slate-600 hover:bg-slate-50";
                }
            });
        }

        // ---------- Menu SAYA ----------
        function latestMetric() {
            if (!dbData.metrics.length) return null;
            return [...dbData.metrics].sort((a, b) => new Date(a.date) - new Date(b.date)).pop();
        }

        function fillProfileForm() {
            if (!currentUser) return;
            const p = dbData.profile;
            const m = latestMetric();
            document.getElementById('prof-avatar').innerText = (currentUser.name || 'U').charAt(0).toUpperCase();
            document.getElementById('prof-email').innerText = currentUser.email;
            document.getElementById('prof-name').value = currentUser.name;
            document.getElementById('prof-age').value = p.age;
            document.getElementById('prof-gender').value = p.gender;
            document.getElementById('prof-weight').value = m ? m.weight : p.weight;
            document.getElementById('prof-height').value = m ? m.height : p.height;
            document.getElementById('prof-activity').value = String(p.activity);
            previewProfile();
        }

        function readProfileForm() {
            return {
                name: document.getElementById('prof-name').value.trim(),
                age: parseInt(document.getElementById('prof-age').value),
                gender: document.getElementById('prof-gender').value,
                weight: parseFloat(document.getElementById('prof-weight').value),
                height: parseFloat(document.getElementById('prof-height').value),
                activity: parseFloat(document.getElementById('prof-activity').value)
            };
        }

        function previewProfile() {
            const f = readProfileForm();
            if (!(f.age > 0 && f.weight > 0 && f.height > 0 && f.activity > 0)) return;
            const c = calcProfile(f.age, f.gender, f.weight, f.height, f.activity);
            document.getElementById('prof-prev-cal').innerText = `${c.targetCalories.toLocaleString('id-ID')} kcal`;
            document.getElementById('prof-prev-bmi').innerText = `${c.bmi} (${bmiStatus(parseFloat(c.bmi))})`;
            document.getElementById('prof-prev-ideal').innerText = `${c.idealMin} - ${c.idealMax} kg (optimal ${c.devine} kg)`;
        }

        function handleUpdateProfile(e) {
            e.preventDefault();
            const f = readProfileForm();
            if (!f.name || !(f.age >= 10 && f.age <= 100) || !(f.weight > 0) || !(f.height > 0)) {
                showToast('Periksa kembali data profil Anda.', 'error');
                return;
            }
            const c = calcProfile(f.age, f.gender, f.weight, f.height, f.activity);

            dbData.profile = {
                age: f.age, gender: f.gender, weight: f.weight, height: f.height, activity: f.activity,
                targetCalories: c.targetCalories, idealMin: c.idealMin, idealMax: c.idealMax, devine: c.devine
            };

            // Catat berat/tinggi terbaru sebagai pengukuran hari ini (ganti jika sudah ada)
            const today = dateStr();
            const existing = dbData.metrics.find(m => m.date === today);
            if (existing) {
                existing.weight = f.weight; existing.height = f.height; existing.bmi = c.bmi;
            } else {
                dbData.metrics.push({ id: Date.now(), date: today, weight: f.weight, height: f.height, bmi: c.bmi });
            }
            dbData.metrics.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Sinkronkan ke daftar akun supaya tersimpan permanen
            const users = getUsers();
            const idx = users.findIndex(u => u.email === currentUser.email);
            if (idx >= 0) {
                users[idx].name = f.name;
                users[idx].profile = dbData.profile;
                saveUsers(users);
                currentUser = users[idx];
            }

            if (!saveUserData()) return;
            document.getElementById('user-display-name').innerText = currentUser.name;
            renderAll();
            fillProfileForm();
            showToast(`Profil diperbarui. Target kalori Anda sekarang ${c.targetCalories} kcal/hari.`);
        }

        // ---------- Util unduh file ----------
        function downloadJSON(obj, filename) {
            const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        // ---------- Metrics ----------
        function handleSaveMetrics(e) {
            e.preventDefault();
            const weight = parseFloat(document.getElementById('metric-weight').value);
            const height = parseFloat(document.getElementById('metric-height').value);
            const date = document.getElementById('metric-date').value;
            const bmi = (weight / ((height / 100) ** 2)).toFixed(1);

            dbData.metrics.push({ id: Date.now(), date, weight, height, bmi });
            dbData.metrics.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Jika ini pengukuran terbaru, perbarui profil + target kalori
            const latest = latestMetric();
            if (latest && latest.date === date) {
                const p = dbData.profile;
                const c = calcProfile(p.age, p.gender, weight, height, p.activity);
                Object.assign(p, { weight, height, targetCalories: c.targetCalories, idealMin: c.idealMin, idealMax: c.idealMax, devine: c.devine });
                const users = getUsers();
                const idx = users.findIndex(u => u.email === currentUser.email);
                if (idx >= 0) { users[idx].profile = p; saveUsers(users); }
            }

            saveUserData();
            renderAll();
            fillProfileForm();
            showToast('Data berat & tinggi badan berhasil disimpan.');
            e.target.reset();
            document.getElementById('metric-date').value = dateStr();
        }

        function deleteMetric(id) {
            dbData.metrics = dbData.metrics.filter(m => m.id !== id);
            saveUserData(); renderAll();
            showToast('Pengukuran dihapus.', 'info');
        }

        // ---------- Fluids ----------
        function handleSaveFluid(e) {
            e.preventDefault();
            const name = document.getElementById('fluid-name').value.trim();
            const amount = parseInt(document.getElementById('fluid-amount').value);
            const calories = parseInt(document.getElementById('fluid-calories').value) || 0;

            const newFluid = { id: Date.now(), date: dateStr(), time: timeStr(), name, amount, calories };
            dbData.fluids.unshift(newFluid);

            if (calories > 0) {
                dbData.journal.unshift({
                    id: Date.now() + 1, date: newFluid.date, time: newFluid.time,
                    name: `Minuman: ${name} (${amount}ml)`, calories, protein: 0,
                    carbs: Math.round(calories / 4), fat: 0,
                    description: `Pencatatan cairan otomatis (${amount}ml)`
                });
            }
            saveUserData(); renderAll();
            showToast('Cairan berhasil dicatat!');
            e.target.reset();
            document.getElementById('fluid-calories').value = "0";
        }

        function deleteFluid(id) {
            dbData.fluids = dbData.fluids.filter(f => f.id !== id);
            saveUserData(); renderAll();
            showToast('Catatan cairan dihapus.', 'info');
        }

        // ---------- Gambar ----------
        function compressImage(dataUrl, maxSize = 1024, quality = 0.8) {
            return new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    let { width, height } = img;
                    const scale = Math.min(1, maxSize / Math.max(width, height));
                    width = Math.round(width * scale); height = Math.round(height * scale);
                    const canvas = document.createElement('canvas');
                    canvas.width = width; canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = () => resolve(dataUrl);
                img.src = dataUrl;
            });
        }

        function handleImageSelected(event) {
            const file = event.target.files[0];
            event.target.value = '';
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async e => {
                currentImageBase64 = await compressImage(e.target.result, 896, 0.8);
                document.getElementById('image-preview').src = currentImageBase64;
                document.getElementById('upload-placeholder').classList.add('hidden');
                document.getElementById('preview-container').classList.remove('hidden');
                // Langsung analisis begitu foto dipilih/diambil
                analyzeFoodImage();
            };
            reader.readAsDataURL(file);
        }

        function resetScanner() {
            currentImageBase64 = null;
            lastAIAnalysis = null;
            const ph = document.getElementById('upload-placeholder');
            if (!ph) return;
            ph.classList.remove('hidden');
            document.getElementById('preview-container').classList.add('hidden');
            document.getElementById('ai-result-box').classList.add('hidden');
            analysisSeq++; // batalkan analisis yang masih berjalan
            setAnalyzing(false);
        }

        // ==================== INTEGRASI GEMINI AI ====================
        const NUTRITION_SCHEMA_PROMPT =
            'Kamu ahli gizi yang menghitung kalori makanan Indonesia dengan teliti. Aturan: ' +
            '(1) Pecah menu menjadi komponen terpisah (misal mie ayam = mie, topping ayam, sawi, pangsit goreng, kuah). ' +
            '(2) Perkirakan berat/porsi tiap komponen secara realistis untuk 1 porsi orang dewasa, gunakan acuan TKPI Indonesia atau USDA. ' +
            '(3) Jika ada kemasan dengan label (ml, kcal, merek), pakai informasi label tersebut. ' +
            '(4) Jangan melebih-lebihkan; jangan menambah komponen yang tidak terlihat atau tidak disebut. ' +
            '(5) Jika jumlah/porsi tidak jelas, asumsikan porsi standar dan tulis asumsinya di description. ' +
            'Balas HANYA dengan JSON murni (tanpa markdown) berisi kunci: ' +
            'isFood (boolean, false jika bukan makanan/minuman), ' +
            'name (string, nama menu singkat Bahasa Indonesia), ' +
            'items (array objek per komponen: name string, portion string contoh "1 mangkuk (250 g)", calories number, protein number gram, carbs number gram, fat number gram), ' +
            'caloriesMin (number, batas bawah total), caloriesMax (number, batas atas total), ' +
            'isFluid (boolean, true jika menu utamanya minuman), volume (number ml jika minuman, selain itu 0), ' +
            'description (string singkat Bahasa Indonesia: asumsi porsi yang dipakai). ' +
            'Angka pada items adalah untuk porsi yang terlihat/disebut, bukan per 100 gram.';

        // Cari model Flash yang benar-benar tersedia untuk key ini (nama model sering berganti)
        const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];
        let cachedModels = null;

        async function getModelList() {
            if (cachedModels) return cachedModels;
            try {
                const res = await fetch(GEMINI_PROXY + '/v1beta/models?pageSize=200');
                const data = await res.json();
                const found = (data.models || [])
                    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                    .map(m => m.name.replace('models/', ''))
                    .map(n => { const mt = n.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/); return mt ? { n, v: parseFloat(mt[1]), lite: !!mt[2] } : null; })
                    .filter(Boolean)
                    .sort((a, b) => (b.v - a.v) || (a.lite - b.lite))
                    .map(x => x.n);
                cachedModels = [...found.slice(0, 3), ...FALLBACK_MODELS.filter(m => !found.includes(m))];
            } catch (e) {
                console.warn('Gagal memuat daftar model, memakai daftar bawaan', e);
                cachedModels = FALLBACK_MODELS.slice();
            }
            if (!cachedModels.length) cachedModels = FALLBACK_MODELS.slice();
            return cachedModels;
        }

        const sleep = ms => new Promise(r => setTimeout(r, ms));

        async function requestModel(model, parts, withThinkingOff) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 30000);
            try {
                const generationConfig = { responseMimeType: 'application/json', temperature: 0.1 };
                if (withThinkingOff) generationConfig.thinkingConfig = { thinkingBudget: 0 };
                const res = await fetch(`${GEMINI_PROXY}/v1beta/models/${model}:generateContent`, {
                    method: 'POST',
                    signal: ctrl.signal,
                    headers: { 'Content-Type': 'text/plain' }, // text/plain = tanpa preflight CORS; Worker meneruskan sebagai JSON
                    body: JSON.stringify({ contents: [{ parts }], generationConfig })
                });
                let d = null;
                try { d = await res.json(); } catch (_) {}
                return { ok: res.ok && d && !d.error, status: res.status, data: d, msg: (d && d.error && d.error.message) || `HTTP ${res.status}` };
            } catch (e) {
                return { ok: false, status: 0, data: null, msg: e.name === 'AbortError' ? 'Waktu habis (server AI terlalu lama merespons)' : (/failed to fetch/i.test(e.message) ? 'Tidak bisa terhubung ke Worker AI. Pastikan Worker sudah di-deploy dengan kode terbaru.' : e.message) };
            } finally {
                clearTimeout(timer);
            }
        }

        async function callGemini(parts) {
            if (GEMINI_PROXY.startsWith('ISI_')) {
                throw new Error('URL Worker Gemini belum diisi di kode (konstanta GEMINI_PROXY).');
            }
            const models = await getModelList();
            let lastMsg = 'Gagal menghubungi AI.';
            let data = null;

            // Maksimal 2 putaran: model sibuk (503/429) atau tidak tersedia -> coba model berikutnya
            outer:
            for (let round = 0; round < 2; round++) {
                for (const model of models) {
                    // Matikan "thinking" agar jauh lebih cepat; jika model menolak, ulangi tanpa itu
                    let r = await requestModel(model, parts, true);
                    if (!r.ok && r.status === 400 && /thinking/i.test(r.msg)) r = await requestModel(model, parts, false);
                    if (r.ok) { data = r.data; break outer; }
                    lastMsg = r.msg;
                    const retryable = r.status === 0 || r.status === 404 || r.status === 429 || r.status >= 500 ||
                        /no longer available|not found|not supported|high demand|overloaded|unavailable|deprecated/i.test(r.msg);
                    if (!retryable) break outer; // key salah, request salah, dsb: tidak ada gunanya mencoba model lain
                }
                await sleep(1500);
            }
            if (!data) throw new Error(lastMsg);

            const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
            if (!text) throw new Error('AI tidak memberikan hasil. Coba foto/deskripsi yang lebih jelas.');
            const m = text.match(/\{[\s\S]*\}/);
            return JSON.parse((m ? m[0] : text).replace(/```json|```/g, '').trim());
        }

        function normalizeAnalysis(p, fallbackDesc) {
            if (p.isFood === false) throw new Error('Yang terdeteksi bukan makanan atau minuman. Coba foto lain.');
            const num = (v, d = 0) => { v = parseFloat(v); return isFinite(v) ? v : d; };

            const items = Array.isArray(p.items) ? p.items.filter(i => i && i.name) : [];
            let calories, protein, carbs, fat;
            if (items.length) {
                // Total dihitung dari jumlah komponen agar konsisten dan tidak "ngarang"
                calories = items.reduce((a, i) => a + num(i.calories), 0);
                protein = items.reduce((a, i) => a + num(i.protein), 0);
                carbs = items.reduce((a, i) => a + num(i.carbs), 0);
                fat = items.reduce((a, i) => a + num(i.fat), 0);
            } else {
                calories = num(p.avgCalories, (num(p.caloriesMin) + num(p.caloriesMax)) / 2);
                protein = num(p.protein); carbs = num(p.carbs); fat = num(p.fat);
            }
            calories = Math.round(calories);
            if (!(calories > 0) && !items.length) throw new Error('AI tidak dapat memperkirakan kalori. Coba deskripsi/foto yang lebih jelas.');

            let min = num(p.caloriesMin, Math.round(calories * 0.85));
            let max = num(p.caloriesMax, Math.round(calories * 1.15));
            if (min > calories || max < calories) { min = Math.round(calories * 0.85); max = Math.round(calories * 1.15); }

            const detail = items.map(i => `${i.name} ${i.portion ? '(' + i.portion + ')' : ''} ±${Math.round(num(i.calories))} kcal`).join(' • ');
            const description = [detail, p.description || fallbackDesc].filter(Boolean).join('. ');

            return {
                name: p.name || 'Makanan',
                caloriesMin: Math.round(min), caloriesMax: Math.round(max), calories,
                protein: Math.round(protein), carbs: Math.round(carbs), fat: Math.round(fat),
                isFluid: !!p.isFluid, volume: Math.round(num(p.volume, 250)) || 250,
                description
            };
        }

        // Penanda permintaan terbaru: hasil lama tidak menimpa/menyembunyikan hasil yang baru
        let analysisSeq = 0;

        function setAnalyzing(on) {
            const loading = document.getElementById('ai-loading');
            loading.classList.toggle('hidden', !on);
            if (on) {
                document.getElementById('ai-result-box').classList.add('hidden');
                loading.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            const imgBtn = document.getElementById('analyze-btn');
            const txtBtn = document.getElementById('analyze-text-btn');
            if (imgBtn) imgBtn.disabled = on;
            if (txtBtn) {
                txtBtn.disabled = on;
                txtBtn.querySelector('span').innerText = on ? 'AI sedang menganalisis...' : 'Analisis Deskripsi dengan AI';
            }
        }

        async function analyzeFoodImage() {
            if (!currentImageBase64) return;
            const seq = ++analysisSeq;
            setAnalyzing(true);

            try {
                const base64Data = currentImageBase64.split(',')[1];
                const mimeType = currentImageBase64.substring(currentImageBase64.indexOf(':') + 1, currentImageBase64.indexOf(';'));
                const parsed = await callGemini([
                    { text: 'Analisis foto makanan atau minuman ini secara akurat dan hitung kalorinya. ' + NUTRITION_SCHEMA_PROMPT },
                    { inline_data: { mime_type: mimeType, data: base64Data } }
                ]);
                if (seq !== analysisSeq) return;
                lastAIAnalysis = normalizeAnalysis(parsed, 'Analisis foto makanan via Gemini AI');
                displayAIResult();
                showToast(`Terdeteksi: ${lastAIAnalysis.name} (~${lastAIAnalysis.calories} kcal)`);
            } catch (err) {
                if (seq !== analysisSeq) return;
                console.error(err);
                showToast(`Gagal menganalisis foto: ${err.message}. Anda bisa memakai menu Simpan Kalori Manual.`, 'error');
            } finally {
                if (seq === analysisSeq) setAnalyzing(false);
            }
        }

        async function analyzeTextFood() {
            const text = document.getElementById('food-text-input').value.trim();
            if (!text) { showToast('Mohon tulis deskripsi makanan atau minuman terlebih dahulu.', 'error'); return; }
            const seq = ++analysisSeq;
            setAnalyzing(true);

            try {
                const parsed = await callGemini([{ text: `Analisis menu makanan/minuman berikut: "${text}". ` + NUTRITION_SCHEMA_PROMPT }]);
                if (seq !== analysisSeq) return;
                lastAIAnalysis = normalizeAnalysis(parsed, `Analisis teks: "${text}"`);
                displayAIResult();
                showToast(`Terdeteksi: ${lastAIAnalysis.name} (~${lastAIAnalysis.calories} kcal)`);
            } catch (err) {
                if (seq !== analysisSeq) return;
                console.error(err);
                showToast(`Gagal menganalisis teks: ${err.message}. Anda bisa memakai menu Simpan Kalori Manual.`, 'error');
            } finally {
                if (seq === analysisSeq) setAnalyzing(false);
            }
        }

        function displayAIResult() {
            const a = lastAIAnalysis;
            document.getElementById('res-food-name').innerText = a.name;
            document.getElementById('res-calorie-avg').innerText = a.calories;
            document.getElementById('res-calorie-range').innerText = `${a.caloriesMin} - ${a.caloriesMax} kcal`;
            document.getElementById('res-protein').innerText = a.protein + 'g';
            document.getElementById('res-carbs').innerText = a.carbs + 'g';
            document.getElementById('res-fat').innerText = a.fat + 'g';
            document.getElementById('res-description').innerText = a.description;
            document.getElementById('res-is-fluid-badge').classList.toggle('hidden', !a.isFluid);
            document.getElementById('ai-result-box').classList.remove('hidden');
            document.getElementById('ai-result-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        function saveScannedFood() {
            if (!lastAIAnalysis) return;
            const a = lastAIAnalysis;
            const today = dateStr(), time = timeStr();

            dbData.journal.unshift({
                id: Date.now(), date: today, time,
                name: a.name, calories: a.calories, protein: a.protein, carbs: a.carbs, fat: a.fat,
                description: `${a.description} (Est: ${a.caloriesMin}-${a.caloriesMax} kcal)`
            });
            if (a.isFluid) {
                dbData.fluids.unshift({ id: Date.now() + 1, date: today, time, name: a.name, amount: a.volume || 250, calories: a.calories });
            }
            saveUserData(); renderAll();
            showToast('Berhasil disimpan ke Jurnal & Cairan!');
            resetScanner();
            document.getElementById('food-text-input').value = '';
            switchTab('journal');
        }

        function deleteJournal(id) {
            dbData.journal = dbData.journal.filter(j => j.id !== id);
            saveUserData(); renderAll();
            showToast('Item jurnal dihapus.', 'info');
        }

        // ---------- Render ----------
        function renderAll() {
            renderDashboard();
            renderMetricsTable();
            renderFluidTable();
            renderJournalTable();
            renderCharts();
        }

        function renderDashboard() {
            const today = dateStr();
            const totalCalories = dbData.journal.filter(j => j.date === today).reduce((a, c) => a + (c.calories || 0), 0);
            const totalFluids = dbData.fluids.filter(f => f.date === today).reduce((a, c) => a + (c.amount || 0), 0);
            const targetCal = dbData.profile.targetCalories || 2000;

            document.getElementById('dash-total-calories').innerHTML = `${totalCalories} <span class="text-xs font-normal text-slate-500">kcal</span>`;
            document.getElementById('dash-target-calories').innerHTML = `${targetCal} <span class="text-xs font-normal text-slate-500">kcal</span>`;
            document.getElementById('dash-remaining-calories').innerText = `${targetCal - totalCalories} kcal`;
            document.getElementById('dash-total-fluids').innerHTML = `${totalFluids} <span class="text-xs font-normal text-slate-500">ml</span>`;

            const p = dbData.profile;
            document.getElementById('dash-ideal-title').innerText = `Rekomendasi Berat Badan: ${p.idealMin} kg - ${p.idealMax} kg (Optimal: ${p.devine} kg)`;

            const latest = latestMetric();
            document.getElementById('dash-bmi-status').innerText = latest ? `${latest.bmi} (${bmiStatus(parseFloat(latest.bmi))})` : '-';
        }

        function renderMetricsTable() {
            const tbody = document.getElementById('metrics-table-body');
            if (dbData.metrics.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-slate-400 italic">Belum ada riwayat pengukuran.</td></tr>`;
                return;
            }
            const sortedDesc = [...dbData.metrics].sort((a, b) => new Date(b.date) - new Date(a.date));
            tbody.innerHTML = sortedDesc.map(m => `
                <tr class="hover:bg-slate-50 transition">
                    <td class="py-2.5 px-3 md:py-3 md:px-4 font-medium text-slate-700">${esc(m.date)}</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 font-bold text-slate-900">${esc(m.weight)} kg</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-slate-600">${esc(m.height)} cm</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-blue-600 font-semibold">${esc(m.bmi)}</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-right"><button onclick="deleteMetric(${Number(m.id)})" class="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg transition"><i class="fa-solid fa-trash-can"></i></button></td>
                </tr>`).join('');
        }

        function renderFluidTable() {
            const tbody = document.getElementById('fluid-table-body');
            const today = dateStr();
            const list = dbData.fluids.filter(f => f.date === today);
            document.getElementById('fluid-total-badge').innerText = `${list.reduce((a, c) => a + (c.amount || 0), 0)} ml`;
            if (list.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-slate-400 italic">Belum ada catatan cairan hari ini.</td></tr>`;
                return;
            }
            tbody.innerHTML = list.map(f => `
                <tr class="hover:bg-slate-50 transition">
                    <td class="py-2.5 px-3 md:py-3 md:px-4 font-medium text-slate-700">${esc(f.time)}</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 font-bold text-slate-900">${esc(f.name)}</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-cyan-600 font-semibold">${esc(f.amount)} ml</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-slate-600">${esc(f.calories)} kcal</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-right"><button onclick="deleteFluid(${Number(f.id)})" class="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg transition"><i class="fa-solid fa-trash-can"></i></button></td>
                </tr>`).join('');
        }

        function renderJournalTable() {
            const tbody = document.getElementById('journal-table-body');
            if (dbData.journal.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-slate-400 italic">Jurnal makanan masih kosong.</td></tr>`;
                return;
            }
            tbody.innerHTML = dbData.journal.map(j => `
                <tr class="hover:bg-slate-50 transition">
                    <td class="py-2.5 px-3 md:py-3 md:px-4 font-medium text-slate-700">${esc(j.date)} ${j.time ? '(' + esc(j.time) + ')' : ''}</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4">
                        <p class="font-bold text-slate-900">${esc(j.name)}</p>
                        <p class="text-xs text-slate-400 truncate max-w-xs">${esc(j.description || '')}</p>
                    </td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 font-bold text-emerald-600">${esc(j.calories)} kcal</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-xs text-slate-600">P: ${esc(j.protein)}g | K: ${esc(j.carbs)}g | L: ${esc(j.fat)}g</td>
                    <td class="py-2.5 px-3 md:py-3 md:px-4 text-right"><button onclick="deleteJournal(${Number(j.id)})" class="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg transition"><i class="fa-solid fa-trash-can"></i></button></td>
                </tr>`).join('');
        }

        function resetDateFilter(render = true) {
            const today = new Date();
            const past30 = new Date();
            past30.setDate(today.getDate() - 30);
            document.getElementById('filter-end-date').value = dateStr(today);
            document.getElementById('filter-start-date').value = dateStr(past30);
            if (render) renderCharts();
        }

        function renderCharts() {
            if (!currentUser || currentUser.role === 'admin') return;
            const start = document.getElementById('filter-start-date').value;
            const end = document.getElementById('filter-end-date').value;
            const inRange = d => (!start || !end) ? true : (d >= start && d <= end);

            const fm = dbData.metrics.filter(m => inRange(m.date));
            const fj = dbData.journal.filter(j => inRange(j.date));

            const calorieMap = {};
            fj.forEach(j => { calorieMap[j.date] = (calorieMap[j.date] || 0) + (j.calories || 0); });

            const dates = Array.from(new Set([...fm.map(m => m.date), ...Object.keys(calorieMap)])).sort((a, b) => new Date(a) - new Date(b));
            const weightData = dates.map(d => { const f = fm.find(m => m.date === d); return f ? f.weight : null; });
            const calorieData = dates.map(d => calorieMap[d] || 0);

            if (weightChartInstance) weightChartInstance.destroy();
            weightChartInstance = new Chart(document.getElementById('weightChart').getContext('2d'), {
                type: 'line',
                data: { labels: dates, datasets: [{ label: 'Berat Badan (kg)', data: weightData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', borderWidth: 2, fill: true, tension: 0.3, spanGaps: true }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false } } }
            });

            if (calorieChartInstance) calorieChartInstance.destroy();
            calorieChartInstance = new Chart(document.getElementById('calorieChart').getContext('2d'), {
                type: 'bar',
                data: { labels: dates, datasets: [{ label: 'Kalori Masuk (kcal)', data: calorieData, backgroundColor: '#10b981', borderRadius: 6 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
        }

        // ---------- Export ----------
        function openExportModal() { document.getElementById('export-modal').classList.remove('hidden'); }
        function closeExportModal() { document.getElementById('export-modal').classList.add('hidden'); }
        function exportDataJSON() {
            downloadJSON(dbData, `ohealthy_health_data_${currentUser.email.split('@')[0]}.json`);
            closeExportModal();
            showToast('Data berhasil di-export.');
        }
    

        // ---------- Katalog Kalori Manual (data di data.js) ----------
        function foodPer(f, g) { const k = g / 100; return { calories: Math.round(f[1] * k), protein: +(f[2] * k).toFixed(1), fat: +(f[3] * k).toFixed(1), carbs: +(f[4] * k).toFixed(1) }; }
        function renderCatalog() {
            const q = (document.getElementById('cat-search').value || '').toLowerCase().trim();
            const rows = FOOD_CATALOG.map((f, i) => [f, i]).filter(([f]) => !q || f[0].toLowerCase().includes(q)).slice(0, 60);
            document.getElementById('cat-list').innerHTML = rows.length ? rows.map(([f, i]) => { const n = foodPer(f, f[6]);
                return `<div class="flex items-center justify-between gap-2 p-3 border border-slate-100 rounded-xl"><div class="min-w-0"><div class="font-semibold text-sm text-slate-800">${esc(f[0])}</div><div class="text-xs text-slate-500">${esc(f[5])} (${f[6]} g) • ${n.calories} kcal • P ${n.protein}g • K ${n.carbs}g • L ${n.fat}g</div></div><div class="flex items-center gap-2 shrink-0"><input id="cat-qty-${i}" type="number" min="0.25" step="0.25" value="1" class="w-16 px-2 py-1 border border-slate-200 rounded-lg text-sm"><button onclick="addCatalogFood(${i})" class="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold">Simpan</button></div></div>`; }).join('')
                : '<p class="text-sm text-slate-500 p-3">Tidak ditemukan. Gunakan form isi sendiri di bawah.</p>';
        }
        function logFood(name, n, desc) {
            dbData.journal.unshift({ id: Date.now(), date: dateStr(), time: timeStr(), name, calories: n.calories, protein: n.protein, carbs: n.carbs, fat: n.fat, description: desc });
            saveUserData(); renderAll(); showToast('Berhasil disimpan ke Jurnal!'); switchTab('journal');
        }
        function addCatalogFood(i) {
            const f = FOOD_CATALOG[i], qty = parseFloat(document.getElementById('cat-qty-' + i).value) || 1;
            logFood(f[0], foodPer(f, f[6] * qty), `Katalog manual: ${qty} × ${f[5]} (${Math.round(f[6] * qty)} g)`);
        }
        function saveCustomFood() {
            const v = id => document.getElementById(id).value, p = id => parseFloat(v(id)) || 0;
            const name = v('cf-name').trim(), c = parseFloat(v('cf-cal'));
            if (!name || !isFinite(c)) { showToast('Isi nama dan kalori.', 'error'); return; }
            logFood(name, { calories: Math.round(c), protein: p('cf-p'), carbs: p('cf-c'), fat: p('cf-f') }, 'Input manual');
            ['cf-name', 'cf-cal', 'cf-p', 'cf-c', 'cf-f'].forEach(id => document.getElementById(id).value = '');
        }