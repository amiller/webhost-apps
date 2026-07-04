import webpush from "npm:web-push@3.6.7";
const k = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + k.publicKey);
console.log("VAPID_PRIVATE_KEY=" + k.privateKey);
