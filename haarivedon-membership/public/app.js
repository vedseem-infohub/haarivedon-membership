(function () {
  'use strict';

  var MESSAGES = {
    membership: {
      paid: 'Welcome to the Haarivedon 365-Day Membership! Our team will contact you on your registered mobile number within 24 hours with your webinar links.',
    },
    course: {
      paid: 'Your enrollment in the Draftsmanship course is confirmed. Our team will contact you within 24 hours with your class schedule.',
      details: 'Thank you! Our team will call you shortly with complete Draftsmanship course details.',
    },
  };

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var loader = $('#loader');
  var modal = $('#modal');
  document.getElementById('year').textContent = new Date().getFullYear();

  // In-app browsers (Instagram, Facebook, etc.) on iOS/Android handle checkout popups poorly; use redirect mode there.
  var ua = navigator.userAgent || '';
  var isInApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|LinkedInApp|Twitter/i.test(ua);

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'same-origin',
    }).then(function (r) {
      return r.text().then(function (rawText) {
        var j = {};
        try { j = JSON.parse(rawText); } catch (_) {}
        if (!r.ok) {
          var msg = j.error || j.message || (rawText && rawText.length < 150 ? rawText : '') || ('Server error (' + r.status + '). Please try again.');
          throw new Error(msg);
        }
        return j;
      });
    });
  }

  function showModal(title, text, ok) {
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    var icon = $('#modal-icon');
    icon.textContent = ok ? '✓' : '!';
    icon.className = 'modal-icon' + (ok ? '' : ' error');
    modal.hidden = false;
    $('#modal-close').focus();
  }
  $('#modal-close').addEventListener('click', function () { modal.hidden = true; });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.hidden = true; });

  function setMsg(form, text, type) {
    var el = $('.form-msg', form);
    el.textContent = text || '';
    el.className = 'form-msg' + (type ? ' ' + type : '');
  }

  function validate(form) {
    var errors = [];
    var fields = form.querySelectorAll('input, textarea');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      f.value = f.value.trim ? f.value.replace(/^\s+/, '') : f.value;
      var bad = false;
      if (f.name === 'mobile') {
        f.value = f.value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
        bad = !/^[6-9]\d{9}$/.test(f.value);
        if (bad) errors.push('Enter a valid 10-digit mobile number');
      } else if (f.name === 'dob') {
        bad = !/^\d{4}-\d{2}-\d{2}$/.test(f.value) || new Date(f.value) > new Date();
        if (bad) errors.push('Select your date of birth');
      } else if (f.name === 'name') {
        bad = f.value.trim().length < 2;
        if (bad) errors.push('Enter your full name');
      } else if (f.name === 'address') {
        bad = f.value.trim().length < 5;
        if (bad) errors.push('Enter your address');
      }
      f.classList.toggle('invalid', bad);
    }
    return errors;
  }

  // Track which submit button was tapped (e.submitter is missing on older iOS Safari).
  var lastIntent = new WeakMap();
  document.querySelectorAll('.lead-form button[type=submit]').forEach(function (btn) {
    btn.addEventListener('click', function () { lastIntent.set(btn.form, btn.getAttribute('data-intent')); });
  });

  document.querySelectorAll('.lead-form').forEach(function (form) {
    var dob = form.querySelector('input[name=dob]');
    if (dob) dob.max = new Date().toISOString().slice(0, 10);

    form.querySelectorAll('input, textarea').forEach(function (f) {
      f.addEventListener('input', function () { f.classList.remove('invalid'); });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var intent = (e.submitter && e.submitter.getAttribute('data-intent')) || lastIntent.get(form) || 'pay';
      var errors = validate(form);
      if (errors.length) {
        setMsg(form, errors[0], 'error');
        var first = form.querySelector('.invalid');
        if (first) first.focus();
        return;
      }
      setMsg(form, '');
      var product = form.getAttribute('data-product');
      var data = { product: product, intent: intent, source: location.href };
      new FormData(form).forEach(function (v, k) { data[k] = v; });

      var buttons = form.querySelectorAll('button');
      buttons.forEach(function (b) { b.disabled = true; });
      if (intent === 'pay') loader.hidden = false;

      post('/api/lead', data)
        .then(function (res) {
          if (intent === 'details') {
            form.reset();
            showModal('Request received', MESSAGES[product].details, true);
            return;
          }
          return startPayment(res.leadId, product, form, res.leadToken);
        })
        .catch(function (err) {
          loader.hidden = true;
          setMsg(form, err.message, 'error');
        })
        .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
    });
  });

  function waitForRazorpay(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function check() {
        if (window.Razorpay) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('Payment gateway failed to load. Please check your internet connection and try again.'));
        setTimeout(check, 150);
      })();
    });
  }

  function startPayment(leadId, product, form, leadToken) {
    return Promise.all([post('/api/order', { leadId: leadId, leadToken: leadToken }), waitForRazorpay(10000)]).then(function (r) {
      var order = r[0];
      var options = {
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: 'HaarivedOn',
        description: order.name + ' – ' + order.description,
        image: location.origin + '/assets/logo.png',
        prefill: order.prefill,
        notes: { lead_id: leadId, product: product },
        theme: { color: '#0b3d2e' },
        retry: { enabled: true },
        modal: {
          ondismiss: function () {
            post('/api/checkout-event', { leadId: leadId, leadToken: leadToken, event: 'dismissed' }).catch(function () {});
            setMsg(form, 'Payment was not completed. Tap the button again to retry.', 'error');
          },
          confirm_close: true,
          backdropclose: false,
        },
        handler: function (resp) {
          loader.hidden = false;
          loader.querySelector('p').textContent = 'Confirming your payment…';
          post('/api/verify', {
            leadId: leadId,
            leadToken: leadToken,
            razorpay_order_id: resp.razorpay_order_id,
            razorpay_payment_id: resp.razorpay_payment_id,
            razorpay_signature: resp.razorpay_signature,
          }).then(function () {
            location.href = '/thank-you.html?product=' + product + '&status=success';
          }).catch(function () {
            loader.hidden = true;
            showModal('Payment received – verifying', 'We received your payment (ID: ' + resp.razorpay_payment_id + ') but could not confirm it automatically. Our team will verify and contact you shortly.', false);
          });
        },
      };
      if (isInApp) {
        options.redirect = true;
        var cb = location.origin + '/api/razorpay/callback?lead=' + encodeURIComponent(leadId);
        if (leadToken) cb += '&token=' + encodeURIComponent(leadToken);
        options.callback_url = cb;
      }
      var rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (resp) {
        var reason = (resp && resp.error && resp.error.description) || 'Payment failed';
        post('/api/checkout-event', { leadId: leadId, leadToken: leadToken, event: 'failed', reason: reason }).catch(function () {});
      });
      loader.hidden = true;
      rzp.open();
    });
  }

  // Hide sticky CTA when a form or the join section is in view.
  var sticky = document.getElementById('sticky-cta');
  if ('IntersectionObserver' in window && sticky) {
    var visible = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { en.isIntersecting ? visible.add(en.target) : visible.delete(en.target); });
      sticky.classList.toggle('hide', visible.size > 0);
    }, { threshold: 0.15 });
    document.querySelectorAll('.lead-form, .hero .cta-row').forEach(function (el) { io.observe(el); });
  }
})();
