const SIZE_SETS = { TEE_SIZES, HOODIE_SIZES };
let cart = [];
let discount = 0;
let appliedCoupon = "";
const cfg = STORE_CONFIG;
const products = cfg.products.map(p => ({
  ...p,
  sizes: typeof p.sizes === "string" ? (SIZE_SETS[p.sizes] || [p.sizes]) : p.sizes,
  allowsCustomName: p.allowsCustomName ?? (p.type === "shirt" || p.type === "hoodie")
}));

const byId = id => document.getElementById(id);
const mainView = byId("main-view");
const productList = byId("product-list");
const cartItemsList = byId("cart-items");
const cartTotalSpan = byId("cart-total");
const checkoutButton = byId("checkout-button");
const checkoutSection = byId("checkout-section");
const checkoutCartItemsList = byId("checkout-cart-items");
const checkoutSubtotalSpan = byId("checkout-subtotal");
const checkoutDiscountSpan = byId("checkout-discount");
const checkoutCartTotalSpan = byId("checkout-cart-total");
const placeOrderButton = byId("place-order-button");
const backToCartButton = byId("back-to-cart-button");
const checkoutForm = byId("checkout-form");
const couponCodeInput = byId("coupon-code");
const applyCouponButton = byId("apply-coupon-button");
const messageBox = byId("message-box");
const messageText = byId("message-text");
const closeMessageButton = byId("close-message");
const previewModal = byId("preview-modal");
const previewImageSlider = byId("preview-image-slider");
const previewDotsContainer = byId("preview-dots-container");
const prevImageButton = byId("prev-image");
const nextImageButton = byId("next-image");
const closePreviewModalButton = byId("close-preview-modal");
const previewTitle = byId("preview-title");
const sizeChartModal = byId("size-chart-modal");
const sizeChartBtn = byId("size-chart-btn");
const closeSizeChartModalBtn = byId("close-size-chart-modal");
const sizeChartContent = byId("size-chart-content");
const customNameModal = byId("custom-name-modal");
const modalCustomNameInput = byId("modal-custom-name");
const saveCustomNameButton = byId("save-custom-name");
const cancelCustomNameButton = byId("cancel-custom-name");
const customNameHint = byId("custom-name-hint");
const cartIcon = byId("cart-icon");
const catalogueBtn = byId("catalogue-btn");
const cartItemCount = byId("cart-item-count");
const processingOverlay = byId("processing-overlay");
let currentProductIndex = 0;
let currentImageIndex = 0;
let activeModalImages = [];
let activeCustomNameProductCard = null;

const money = amount => `₹${Number(amount || 0).toLocaleString("en-IN")}`;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const getProduct = id => products.find(p => p.id === Number(id));
const loadServerProducts = async () => {
  try {
    const response = await fetch("/api/catalogue");
    const catalogue = await response.json();
    if (!response.ok || !Array.isArray(catalogue.products)) return;
    catalogue.products.forEach(product => {
      if (!getProduct(product.id)) products.push(product);
    });
  } catch {}
};
const getItemPrice = item => {
  const product = getProduct(item.id);
  return (product?.price || 0) + (item.customName ? cfg.customNameFee : 0) + (item.size === "XXL" ? cfg.xxlFee : 0);
};
const getCartSubtotal = () => cart.reduce((sum, item) => sum + getItemPrice(item) * (item.quantity || 1), 0);
const getCartTotal = () => Math.max(0, getCartSubtotal() - discount);
const loadCart = () => {
  try { cart = JSON.parse(localStorage.getItem("merchStoreCart") || "[]"); }
  catch { cart = []; }
};
const saveCart = () => localStorage.setItem("merchStoreCart", JSON.stringify(cart));
const saveCheckoutForm = () => {
  const formData = Object.fromEntries(new FormData(checkoutForm).entries());
  localStorage.setItem("merchStoreCheckoutForm", JSON.stringify(formData));
};
const loadCheckoutForm = () => {
  try {
    const data = JSON.parse(localStorage.getItem("merchStoreCheckoutForm") || "{}");
    Object.entries(data).forEach(([key, value]) => {
      const input = checkoutForm.elements.namedItem(key);
      if (input && input.type !== "file") input.value = value;
    });
  } catch {}
};
const showMessage = message => {
  messageText.textContent = message;
  messageBox.classList.remove("hidden");
  messageBox.classList.add("flex");
};
const hideModal = modal => { modal.classList.add("hidden"); modal.classList.remove("flex"); };
const showModal = (modal, modalState) => {
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  history.pushState({ ...(history.state || {}), modal: modalState }, "", location.href);
};
const showToast = message => {
  byId("toast-message").textContent = message;
  const toast = byId("toast-notification");
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
};
const getSelected = (card, selector) => card.querySelector(`${selector}.selected`);
const updateProductCardState = card => {
  const toggle = card.querySelector(".custom-name-toggle");
  const nameField = card.querySelector(".custom-name-value");
  if (toggle && nameField) nameField.disabled = !toggle.checked;
};

const renderProducts = () => {
  byId("product-count-label").textContent = `${products.length} styles`;
  productList.innerHTML = products.map((product, productIndex) => {
    const firstColor = product.colors[0];
    const images = product.images[firstColor] || [];
    const image = images[0] || "";
    return `
      <article class="product-card" data-product-id="${product.id}">
        <div class="relative bg-gray-100 aspect-[4/3] overflow-hidden">
          <button type="button" class="product-image-trigger w-full h-full flex items-center justify-center" data-action="preview" aria-label="Preview ${escapeHtml(product.name)}">
            <img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.classList.remove('hidden')">
            <div class="hidden absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-gradient-to-br from-gray-900 to-purple-950 text-white">
              <span class="text-xs uppercase tracking-[.25em] text-yellow-300 mb-3">IITDH / 2026</span><span class="text-3xl font-black">${escapeHtml(product.type === "hoodie" ? "CAMPUS HOODIE" : "CAMPUS TEE")}</span><span class="text-sm text-gray-300 mt-2">${escapeHtml(product.name)}</span>
            </div>
          </button>
          <span class="absolute top-4 left-4 bg-white/90 text-gray-900 text-[10px] font-extrabold uppercase tracking-widest px-3 py-1.5 rounded-full">${escapeHtml(product.type)}</span>
        </div>
        <div class="p-5 md:p-6">
          <div class="flex justify-between items-start gap-3 mb-2"><div><h3 class="font-extrabold text-xl text-gray-900">${escapeHtml(product.name)}</h3><p class="text-xs text-gray-500 mt-1">Designed for campus life</p></div><p class="font-black text-lg whitespace-nowrap">${money(product.price)}</p></div>
          <div class="mt-5"><p class="text-xs font-extrabold uppercase tracking-widest text-gray-500 mb-2">Color</p>
            <div class="color-selector">${product.colors.map((color, i) => `<button type="button" class="color-option-wrapper color-choice" data-color="${escapeHtml(color)}" title="${escapeHtml(color)}"><span class="color-option ${i === 0 ? "selected" : ""}" style="background:${escapeHtml(cfg.colorMap[color] || "#999")}"></span><span>${escapeHtml(color)}</span></button>`).join("")}</div>
          </div>
          <div class="mt-4"><p class="text-xs font-extrabold uppercase tracking-widest text-gray-500 mb-2">Size</p><div class="size-selector">${product.sizes.map((size,i)=>`<button type="button" class="size-option ${i === Math.min(2,product.sizes.length-1) ? "selected":""}" data-size="${escapeHtml(size)}">${escapeHtml(size)}</button>`).join("")}</div></div>
          ${product.allowsCustomName ? `<div class="mt-4 border-t border-gray-100 pt-4"><label class="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" class="custom-name-toggle accent-purple-800"> Add custom name <span class="text-gray-500 font-normal">(+${money(cfg.customNameFee)})</span></label><input type="text" maxlength="20" placeholder="Name to print" class="custom-name-value mt-2 w-full border rounded-xl p-2.5 text-sm uppercase" disabled></div>` : ""}
          <button type="button" class="add-to-cart-btn btn-primary w-full mt-5 py-3.5 rounded-full font-extrabold transition" data-action="add">Add to bag — ${money(product.price)}</button>
        </div>
      </article>`;
  }).join("");
  productList.querySelectorAll(".product-card").forEach(card => updateProductCardState(card));
};

const openPreview = card => {
  const product = getProduct(card.dataset.productId);
  currentProductIndex = products.findIndex(p => p.id === product.id);
  const chosenColor = getSelected(card, ".color-option-wrapper")?.dataset.color || product.colors[0];
  activeModalImages = product.images[chosenColor] || Object.values(product.images)[0] || [];
  if (!activeModalImages.length) activeModalImages = [""];
  previewImageSlider.innerHTML = activeModalImages.map(src => `<img src="${escapeHtml(src)}" class="slider-image" alt="${escapeHtml(product.name)}">`).join("");
  currentImageIndex = 0;
  updateModalImage();
  previewDotsContainer.innerHTML = activeModalImages.map((_,i)=>`<button type="button" aria-label="Go to image ${i+1}" class="dot ${i===0?"active":""}" data-index="${i}"></button>`).join("");
  showModal(previewModal, "preview");
};
const updateModalImage = () => {
  const product = products[currentProductIndex];
  previewImageSlider.style.transform = `translateX(-${currentImageIndex * 100}%)`;
  previewTitle.textContent = product?.name || "";
  previewDotsContainer.querySelectorAll(".dot").forEach(dot => dot.classList.toggle("active", Number(dot.dataset.index) === currentImageIndex));
};
const showPrevImage = () => { if (activeModalImages.length) { currentImageIndex = (currentImageIndex - 1 + activeModalImages.length) % activeModalImages.length; updateModalImage(); } };
const showNextImage = () => { if (activeModalImages.length) { currentImageIndex = (currentImageIndex + 1) % activeModalImages.length; updateModalImage(); } };

const renderCart = () => {
  const totalQty = cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
  cartItemCount.textContent = totalQty;
  if (!cart.length) {
    cartItemsList.innerHTML = `<div class="text-center py-10"><div class="text-4xl mb-3">🛍️</div><p class="font-bold text-lg text-gray-800">Your bag is waiting.</p><p class="text-sm text-gray-500 mt-1">Add something from the collection to get started.</p><a href="#product-section" class="inline-block mt-4 font-bold text-purple-800 underline">Browse the collection</a></div>`;
    checkoutCartItemsList.innerHTML = `<p class="text-sm text-gray-500">No items in the cart.</p>`;
  } else {
    cartItemsList.innerHTML = cart.map((item,index) => {
      const product = getProduct(item.id);
      return `<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border border-gray-100 p-4 rounded-xl">
        <div><p class="font-extrabold">${escapeHtml(product?.name || "Merch item")}</p><p class="text-sm text-gray-500">${escapeHtml(item.color)} · Size ${escapeHtml(item.size)}${item.customName?` · Print: ${escapeHtml(item.customName)}`:""}</p><p class="text-xs text-gray-500 mt-1">Qty ${item.quantity || 1}</p></div>
        <div class="flex items-center justify-between sm:justify-end gap-4"><span class="font-black">${money(getItemPrice(item)*(item.quantity||1))}</span><button type="button" class="remove-from-cart-btn text-sm font-bold text-red-600 hover:underline" data-index="${index}">Remove</button></div>
      </div>`;
    }).join("");
    checkoutCartItemsList.innerHTML = cart.map(item => {
      const product = getProduct(item.id);
      return `<div class="flex justify-between gap-3 text-sm"><span>${escapeHtml(product?.name || "Merch item")} <span class="text-gray-500">× ${item.quantity || 1}</span></span><span class="font-semibold">${money(getItemPrice(item)*(item.quantity||1))}</span></div>`;
    }).join("");
  }
  const subtotal = getCartSubtotal();
  cartTotalSpan.textContent = money(getCartTotal());
  checkoutSubtotalSpan.textContent = money(subtotal);
  checkoutDiscountSpan.textContent = discount ? `−${money(discount)}` : money(0);
  checkoutCartTotalSpan.textContent = money(getCartTotal());
  saveCart();
};
const handleAddToCart = card => {
  const product = getProduct(card.dataset.productId);
  const size = getSelected(card, ".size-option")?.dataset.size;
  const color = getSelected(card, ".color-option-wrapper")?.dataset.color || product.colors[0];
  const customToggle = card.querySelector(".custom-name-toggle");
  const customName = customToggle?.checked ? card.querySelector(".custom-name-value").value.trim().toUpperCase() : "";
  if (!size) { showMessage("Please select a size first."); return; }
  if (customToggle?.checked && !customName) { showMessage("Enter the name you want printed, or untick custom name."); return; }
  const found = cart.find(i => i.id === product.id && i.size === size && i.color === color && (i.customName || "") === customName);
  if (found) found.quantity = (found.quantity || 1) + 1;
  else cart.push({ id: product.id, size, color, customName, quantity: 1 });
  renderCart();
  showToast(`${product.name} added to your bag`);
};
const handleRemoveFromCart = index => {
  cart.splice(index, 1);
  if (cart.length === 0) { discount = 0; appliedCoupon = ""; couponCodeInput.value = ""; }
  renderCart();
};
const setView = view => {
  mainView.classList.toggle("hidden", view !== "main");
  checkoutSection.classList.toggle("hidden", view !== "checkout");
  if (view === "checkout") window.scrollTo({ top: 0, behavior: "smooth" });
  else window.scrollTo({ top: 0, behavior: "smooth" });
};
const setupModalClosing = (modal, closeButton, cancelAction) => {
  modal.addEventListener("click", e => {
    if (e.target === modal) {
      hideModal(modal);
      if (history.state?.modal) history.back();
      if (cancelAction) cancelAction();
    }
  });
  if (closeButton) closeButton.addEventListener("click", () => {
    hideModal(modal);
    if (history.state?.modal) history.back();
    if (cancelAction) cancelAction();
  });
};

const applyCoupon = () => {
  const code = couponCodeInput.value.trim().toUpperCase();
  if (!cart.length) { showMessage("Your bag is empty. Add an item before applying a coupon."); return; }
  const coupon = (cfg.coupons || []).find(c => c.code.toUpperCase() === code);
  if (!coupon) { discount = 0; appliedCoupon = ""; showMessage("That coupon code is not valid."); renderCart(); return; }
  if (cart.reduce((sum, i) => sum + (i.quantity || 1), 0) < coupon.minItems) { discount = 0; appliedCoupon = ""; showMessage(`Coupon ${code} requires at least ${coupon.minItems} item(s).`); renderCart(); return; }
  const subtotal = getCartSubtotal();
  let amount = coupon.type === "percent" ? Math.floor(subtotal * coupon.value / 100) : coupon.value;
  if (coupon.itemsType && cart.every(item => getProduct(item.id)?.type === coupon.itemsType) && typeof coupon.itemsTypeDiscount === "number") amount = coupon.itemsTypeDiscount;
  discount = Math.min(amount, subtotal);
  appliedCoupon = code;
  showMessage(`Coupon ${code} applied — ${money(discount)} off.`);
  renderCart();
};

const buildSizeChart = () => {
  const teeRows = [["Size","Chest (in)","Length (in)","Shoulder (in)"],["XS","36","26","16"],["S","38","28","17"],["M","40","29","18"],["L","42","30","19"],["XL","44","31","20"],["XXL","46","32","21"]];
  const hoodieRows = [["Size","Chest (in)","Length (in)","Shoulder (in)"],["S","40","26","22"],["M","42","27","23"],["L","44","28","24"],["XL","46","29","25"],["XXL","48","30","26"]];
  const makeTable = (title, rows) => `<div class="mb-5"><h4 class="font-extrabold text-gray-900 mb-2">${title}</h4><table class="w-full text-left border-collapse border border-gray-300 text-sm"><tbody>${rows.map((row,i)=>`<tr class="${i===0?"bg-purple-900 text-white":i%2===0?"bg-gray-100":""}">${row.map(cell=>`<td class="border border-gray-300 px-2 py-2 ${i===0?"font-bold":""}">${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  sizeChartContent.innerHTML = makeTable("T-shirts",teeRows) + makeTable("Hoodies",hoodieRows);
};

const generateOrderId = () => {
  const d = new Date();
  return `IITDH-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
};
const updatePaymentQR = () => {
  const container = byId("payment-qr"); if (!container) return;
  container.innerHTML = "";
  if (!cart.length) { container.textContent = "Add items to generate QR"; return; }
  if (typeof QRCode !== "function") { container.textContent = "QR library unavailable. Reload the page."; return; }
  const total = cart.reduce((sum, item) => sum + (Number(item.quantity || 1) * ((getProduct(item.id)?.price || 0) + ((item.customName && item.customName !== "N/A") ? 99 : 0) + (item.size === "XXL" ? 10 : 0))), 0);
  const payable = Math.max(0, total - Number(discount || 0));
  const uri = `upi://pay?pa=9289886267%40sbi&pn=IIT%20Dharwad%20Merch%20Store&am=${payable.toFixed(2)}&cu=INR&tn=${encodeURIComponent("IITDH Merch order")}`;
  new QRCode(container, { text: uri, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
};

const trackVisit = () => {
  if (!cfg.scriptURL) return;
  try {
    let visitorId = localStorage.getItem("merchVisitorId");
    const isNew = !visitorId;
    if (isNew) {
      visitorId = `V${Date.now()}${Math.random().toString(36).slice(2,8)}`;
      localStorage.setItem("merchVisitorId", visitorId);
    }
    const visitNumber = Number(localStorage.getItem("merchVisitCount") || 0) + 1;
    localStorage.setItem("merchVisitCount", String(visitNumber));
    const payload = { type:"visit", visitorId, page:location.pathname+location.hash, referrer:document.referrer||"Direct", userAgent:navigator.userAgent, screen:`${screen.width}x${screen.height}`, language:navigator.language, visitNumber, isNew };
    fetch(cfg.scriptURL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: true }).catch(() => {});
  } catch {}
};

const readScreenshot = file => new Promise((resolve, reject) => {
  if (!file) return reject(new Error("Upload your payment screenshot."));
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error("Screenshot must be a PNG, JPG or WebP image."));
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    resolve(c.toDataURL("image/jpeg", 0.8));
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
  img.src = url;
});
const handlePlaceOrder = async event => {
  event.preventDefault();
  const name = byId("name").value.trim(), email = byId("email").value.trim(), rollNo = byId("roll_no").value.trim(), phone = byId("phone").value.trim(), batchYear = byId("batch_year").value;
  const upiReference = (byId("upi-reference")?.value || "").trim();
  const missing = []; if (!name) missing.push("Full name"); if (!email) missing.push("Institute email"); if (!rollNo) missing.push("Roll number"); if (!phone) missing.push("WhatsApp number"); if (!batchYear) missing.push("Batch / program"); if (!upiReference) missing.push("UPI transaction reference"); if (!byId("payment-screenshot")?.files?.[0]) missing.push("Payment screenshot");
  if (missing.length) { showMessage(`Complete these fields: ${missing.join(", ")}.`); return; }
  if (!/^\d{10}$/.test(phone)) { showMessage("Enter a valid 10-digit WhatsApp number."); return; }
  if (!email.toLowerCase().endsWith("@iitdh.ac.in")) { showMessage("Please use your @iitdh.ac.in institute email."); return; }
  if (!/^[A-Za-z0-9-]{8,80}$/.test(upiReference)) { showMessage("Enter a valid UPI UTR/reference (8–80 letters or digits)."); return; }
  if (!cart.length) { showMessage("Your bag is empty."); return; }
  placeOrderButton.disabled = true; processingOverlay.classList.remove("hidden"); processingOverlay.classList.add("flex");
  try {
    const screenshot = await readScreenshot(byId("payment-screenshot").files[0]);
    const payload = { name, email, rollNo, phone, batchYear, couponCode: appliedCoupon, upiReference, screenshot, items: cart.map(item => ({ name: getProduct(item.id)?.name, quantity: item.quantity || 1, size: item.size, color: item.color, customName: item.customName || "N/A" })) };
    const response = await fetch("/api/submit-upi-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit the order.");
    processingOverlay.classList.add("hidden"); processingOverlay.classList.remove("flex");
    showMessage(`Order placed: ${result.orderId}. ${result.collectionQrEmailed ? "Your collection QR has been emailed to you." : "Your collection QR will be emailed shortly. Keep this order ID."}`);
    checkoutForm.reset(); cart = []; discount = 0; appliedCoupon = ""; couponCodeInput.value = ""; localStorage.removeItem("merchStoreCart"); localStorage.removeItem("merchStoreCheckoutForm"); renderCart(); updatePaymentQR(); productList.querySelectorAll(".product-card").forEach(updateProductCardState); setView("main"); history.pushState({view:"main"},"", "#");
  } catch (error) { processingOverlay.classList.add("hidden"); processingOverlay.classList.remove("flex"); showMessage(error.message || "Could not submit your order. Please retry."); }
  finally { placeOrderButton.disabled = false; }
};
const finishOrder = (orderId, verified = {}) => {
  processingOverlay.classList.add("hidden");
  processingOverlay.classList.remove("flex");
  showMessage(`Payment verified! Order: ${orderId}. ${verified.collectionQrEmailed ? "Your unique collection QR has been emailed." : "Your order is paid; the collection QR email may be delayed while the store finishes syncing. Keep this order reference."}`);
  checkoutForm.reset();
  cart = []; discount = 0; appliedCoupon = ""; couponCodeInput.value = "";
  localStorage.removeItem("merchStoreCart");
  localStorage.removeItem("merchStoreCheckoutForm");
  renderCart(); productList.querySelectorAll(".product-card").forEach(updateProductCardState);
  setView("main"); history.pushState({view:"main"},"", "#");
  placeOrderButton.disabled = false;
};

document.addEventListener("DOMContentLoaded", async () => {
  if (typeof applyStoreConfig === "function") {
    applyStoreConfig();
  }
  updatePaymentQR();
  trackVisit();
  await loadServerProducts();
  loadCart(); loadCheckoutForm(); buildSizeChart(); renderProducts(); renderCart();
  checkoutForm.addEventListener("input", saveCheckoutForm);
  productList.addEventListener("click", event => {
    const card = event.target.closest(".product-card");
    if (!card) return;
    if (event.target.closest(".color-choice")) {
      const choice = event.target.closest(".color-choice");
      card.querySelectorAll(".color-option").forEach(el=>el.classList.remove("selected"));
      choice.querySelector(".color-option").classList.add("selected");
      const product = getProduct(card.dataset.productId);
      const imagePath = product.images[choice.dataset.color]?.[0] || "";
      const img = card.querySelector("img");
      const fallback = img.nextElementSibling;
      img.style.display = ""; img.src = imagePath;
      // fallback reappears if image missing
      img.onerror = () => { img.onerror=null; img.style.display="none"; fallback.classList.remove("hidden"); };
      return;
    }
    if (event.target.closest(".size-option")) {
      const option = event.target.closest(".size-option");
      card.querySelectorAll(".size-option").forEach(el=>el.classList.remove("selected"));
      option.classList.add("selected");
      return;
    }
    if (event.target.closest('[data-action="preview"]')) { openPreview(card); return; }
    if (event.target.closest('[data-action="add"]')) { handleAddToCart(card); return; }
  });
  cartItemsList.addEventListener("click", event => {
    const remove = event.target.closest(".remove-from-cart-btn");
    if (remove) handleRemoveFromCart(Number(remove.dataset.index));
  });
  checkoutButton.addEventListener("click", () => {
    if (!cart.length) { showMessage("Your bag is empty. Add an item before checkout."); return; }
    setView("checkout"); updatePaymentQR();
    history.pushState({view:"checkout"},"","#checkout");
  });
  checkoutForm.addEventListener("submit", handlePlaceOrder);
  backToCartButton.addEventListener("click", () => { setView("main"); history.pushState({view:"main"},"","#cart-section"); });
  applyCouponButton.addEventListener("click", () => { applyCoupon(); updatePaymentQR(); });
  cartIcon.addEventListener("click", () => {
    if (!cart.length) { showMessage("Your bag is empty."); return; }
    setView("main");
    requestAnimationFrame(()=>byId("cart-section").scrollIntoView({behavior:"smooth"}));
  });
  catalogueBtn.addEventListener("click", () => { setView("main"); byId("product-section").scrollIntoView({behavior:"smooth"}); });
  byId("close-message").addEventListener("click", () => hideModal(messageBox));
  closeMessageButton.addEventListener("click", () => hideModal(messageBox));
  prevImageButton.addEventListener("click", showPrevImage);
  nextImageButton.addEventListener("click", showNextImage);
  previewDotsContainer.addEventListener("click", event => { const dot=event.target.closest(".dot"); if(dot){currentImageIndex=Number(dot.dataset.index);updateModalImage();} });
  setupModalClosing(previewModal, closePreviewModalButton);
  setupModalClosing(sizeChartModal, closeSizeChartModalBtn);
  setupModalClosing(customNameModal, cancelCustomNameButton, () => {
    if (activeCustomNameProductCard) {
      const toggle=activeCustomNameProductCard.querySelector(".custom-name-toggle");
      const nameField=activeCustomNameProductCard.querySelector(".custom-name-value");
      if(toggle) toggle.checked=false; if(nameField) nameField.value="";
      updateProductCardState(activeCustomNameProductCard); activeCustomNameProductCard=null;
    }
  });
  saveCustomNameButton.addEventListener("click", () => {
    const name=modalCustomNameInput.value.trim().toUpperCase();
    if(!name){showMessage("Enter a name to print.");return;}
    if(activeCustomNameProductCard){
      activeCustomNameProductCard.querySelector(".custom-name-value").value=name;
      activeCustomNameProductCard.querySelector(".custom-name-toggle").checked=true;
      const card=activeCustomNameProductCard; activeCustomNameProductCard=null;
      hideModal(customNameModal); if(history.state?.modal) history.back(); handleAddToCart(card);
    } else hideModal(customNameModal);
  });
  modalCustomNameInput.addEventListener("keydown", event => { if(event.key==="Enter") saveCustomNameButton.click(); });
  cancelCustomNameButton.addEventListener("click", () => {
    if(activeCustomNameProductCard){const t=activeCustomNameProductCard.querySelector(".custom-name-toggle"); if(t)t.checked=false; const n=activeCustomNameProductCard.querySelector(".custom-name-value"); if(n)n.value=""; updateProductCardState(activeCustomNameProductCard); activeCustomNameProductCard=null;}
    hideModal(customNameModal); if(history.state?.modal) history.back();
  });
  productList.addEventListener("change", event => {
    if (event.target.matches(".custom-name-toggle")) {
      const card=event.target.closest(".product-card");
      if (event.target.checked) { activeCustomNameProductCard=card; modalCustomNameInput.value=card.querySelector(".custom-name-value").value||""; customNameHint.textContent=`Custom print fee: ${money(cfg.customNameFee)}. Your entered name will be printed on the item.`; showModal(customNameModal,"customName"); }
      else { card.querySelector(".custom-name-value").value=""; updateProductCardState(card); }
    }
    updateProductCardState(event.target.closest(".product-card") || event.target);
  });
  sizeChartBtn.addEventListener("click", () => showModal(sizeChartModal,"sizeChart"));
  window.addEventListener("popstate", () => {
    hideModal(previewModal); hideModal(sizeChartModal); hideModal(customNameModal);
    if (history.state?.view === "checkout") setView("checkout"); else setView("main");
  });
  history.replaceState({view:"main"},"", "#");
  customNameHint.textContent = `Add a custom name for ${money(cfg.customNameFee)}.`;
});
