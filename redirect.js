// redirect.js — ColEx home-page redirect helpers
// Fix #5: was pointing to non-existent adminlogin.html
// Fix #11: removed dead toggleMenu / loginBox dropdown code

window.redirectToAdminPage = function () {
    window.location.href = 'login.html';
};

window.redirectToLoginPage = function () {
    window.location.href = 'login.html';
};
