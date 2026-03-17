// ============================================================
//  CGrocs — avatar-upload.js
//  Shared avatar resize + upload logic used by both
//  register.html and setup-profile.html.
//  Include with a plain <script src="avatar-upload.js"></script>
//  (NOT a module — needs to be available before DOMContentLoaded)
// ============================================================

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB hard block
const MAX_AVATAR_PX    = 200;              // resize target

function resizeImageToBase64(file, maxSize) {
    return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('Read failed')); };
        reader.onload  = function (ev) {
            var img = new Image();
            img.onerror = function () { reject(new Error('Load failed')); };
            img.onload  = function () {
                var w = img.width, h = img.height;
                if (w > h) { if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; } }
                else       { if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; } }
                var canvas = document.createElement('canvas');
                canvas.width  = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// Call once the DOM is ready to wire up the avatar file input.
// avatarInputId   — id of the <input type="file"> element
// avatarDisplayId — id of the <img> preview element
function initAvatarUpload(avatarInputId, avatarDisplayId) {
    var input = document.getElementById(avatarInputId);
    if (!input) return;

    input.addEventListener('change', async function (e) {
        var file = e.target.files[0];
        if (!file) return;

        if (file.size > MAX_AVATAR_BYTES) {
            if (window.notify) notify.error('Photo is too large. Please choose an image under 5MB.');
            e.target.value = '';
            return;
        }

        var avatarEl = document.getElementById(avatarDisplayId);
        if (avatarEl) { avatarEl.style.opacity = '0.4'; avatarEl.style.filter = 'blur(2px)'; }

        try {
            var compressed = await resizeImageToBase64(file, MAX_AVATAR_PX);
            window._avatarBase64 = compressed;
            if (avatarEl) {
                avatarEl.src           = compressed;
                avatarEl.style.opacity = '1';
                avatarEl.style.filter  = '';
            }
        } catch (err) {
            if (window.notify) notify.error('Could not process image. Try a different file.');
            e.target.value = '';
            if (avatarEl) { avatarEl.style.opacity = '1'; avatarEl.style.filter = ''; }
        }
    });
}

// Expose for inline HTML usage
window.initAvatarUpload  = initAvatarUpload;
window.resizeImageToBase64 = resizeImageToBase64;
