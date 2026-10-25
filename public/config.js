// IIT Dharwad merch storefront configuration.
// Update store text, product photos/prices, contact details and coupon rules here. Payment prices are revalidated by server.js.
const TEE_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const HOODIE_SIZES = ["S", "M", "L", "XL", "XXL"];

const STORE_CONFIG = {
  storeName: "IIT DH MERCH STORE",
  tagline: "Campus gear, made for your story. ₹1 TEST MODE — verify UTR at collection.",
  announcement: "IITDH MERCH DROP 2026  •  LIMITED CAMPUS COLLECTION  •  ORDER YOUR SIZE",
  upiId: "9289886267@sbi",
  qrImage: "",
  scriptURL: "/api/submit",
  customNameFee: 0,
  xxlFee: 0,
  whatsapp: "918544074404",
  coupons: [],
  colorMap: {
    "Black": "#080808",
    "Navy": "#101d3e",
    "White": "#f4f1e9",
    "Maroon": "#6d1025",
    "Grey": "#808080",
    "Olive": "#556b2f"
  },
  products: [
    { id: 1, name: "Classic T-Shirt", price: 1, type: "shirt", sizes: "TEE_SIZES", colors: ["Black", "Navy"],
      images: { "Black": ["images/tshirt_black_front.svg", "images/tshirt_black_back.svg"], "Navy": ["images/tshirt_navy_front.svg", "images/tshirt_navy_back.svg"] } },
    { id: 2, name: "Polo T-Shirt", price: 1, type: "shirt", sizes: "TEE_SIZES", colors: ["Black", "Navy"],
      images: { "Black": ["images/polo_black_front.svg", "images/polo_black_back.svg"], "Navy": ["images/polo_navy_front.svg", "images/polo_navy_back.svg"] } },
    { id: 3, name: "Zipper Hoodie", price: 1, type: "hoodie", sizes: "HOODIE_SIZES", colors: ["Black"],
      images: { "Black": ["images/zipper_hoodie_black_front.svg", "images/zipper_hoodie_black_back.svg"] } },
    { id: 4, name: "CS Hoodie", price: 1, type: "hoodie", sizes: "HOODIE_SIZES", colors: ["Black"],
      images: { "Black": ["images/cs_hoodie_black_front.svg", "images/cs_hoodie_black_back.svg"] } },
    { id: 5, name: "EE Hoodie", price: 1, type: "hoodie", sizes: "HOODIE_SIZES", colors: ["Black"],
      images: { "Black": ["images/ee_hoodie_black_front.svg", "images/ee_hoodie_black_back.svg"] } }
  ]
};
