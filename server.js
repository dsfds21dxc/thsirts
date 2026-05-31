const express = require('express');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Multer setup for image uploads ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOSECURITY = process.env.ROBLOSECURITY;
const GROUP_ID = process.env.GROUP_ID || null;

// --- Default T-shirt template (a 585x559 solid-color PNG placeholder) ---
// We generate a tiny valid PNG in memory so the app works without uploading an image.
function getDefaultImageBuffer() {
    // 1x1 white PNG (Roblox will accept and scale it)
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    return Buffer.from(base64Png, 'base64');
}

// --- CSRF Token ---
async function fetchCsrfToken() {
    try {
        await axios.post('https://auth.roblox.com/v2/logout', {}, {
            headers: { Cookie: `.ROBLOSECURITY=${ROBLOSECURITY}` }
        });
    } catch (err) {
        const token = err.response?.headers?.['x-csrf-token'];
        if (token) return token;
    }
    return null;
}

// --- Get authenticated user ID ---
async function getAuthenticatedUserId() {
    const res = await axios.get('https://users.roblox.com/v1/users/authenticated', {
        headers: { Cookie: `.ROBLOSECURITY=${ROBLOSECURITY}` }
    });
    return res.data?.id;
}

// --- Create a T-Shirt via Open Cloud Assets API ---
async function createTShirt(name, description, imageBuffer) {
    const form = new FormData();

    const requestBody = {
        assetType: 'TShirt',
        displayName: name,
        description: description || 'T-Shirt',
        creationContext: {
            creator: {}
        }
    };

    if (GROUP_ID) {
        requestBody.creationContext.creator.groupId = parseInt(GROUP_ID);
    } else {
        const userId = await getAuthenticatedUserId();
        requestBody.creationContext.creator.userId = userId;
    }

    form.append('request', JSON.stringify(requestBody));
    form.append('fileContent', imageBuffer, {
        filename: 'tshirt.png',
        contentType: 'image/png'
    });

    const res = await axios.post(
        'https://apis.roblox.com/assets/v1/assets',
        form,
        {
            headers: {
                ...form.getHeaders(),
                'x-api-key': API_KEY,
            }
        }
    );

    return res.data;
}

// --- Poll operation until asset is ready ---
async function pollOperation(operationId, maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const res = await axios.get(
                `https://apis.roblox.com/assets/v1/operations/${operationId}`,
                { headers: { 'x-api-key': API_KEY } }
            );
            if (res.data.done) {
                return res.data.response || res.data;
            }
        } catch (err) {
            console.error('Poll error:', err.response?.data || err.message);
        }
    }
    return null;
}

// --- Put a T-shirt on sale ---
async function putOnSale(assetId, price) {
    const csrf = await fetchCsrfToken();
    if (!csrf) throw new Error('Could not get CSRF token');

    const res = await axios.post(
        `https://itemconfiguration.roblox.com/v1/assets/${assetId}/release`,
        {
            saleStatus: 'OnSale',
            priceConfiguration: {
                priceInRobux: parseInt(price)
            }
        },
        {
            headers: {
                Cookie: `.ROBLOSECURITY=${ROBLOSECURITY}`,
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': csrf
            }
        }
    );
    return res.data;
}

// ===== ROUTES =====

// Health / info
app.get('/status', async (req, res) => {
    res.json({
        success: true,
        mode: GROUP_ID ? 'group' : 'user',
        groupId: GROUP_ID || null,
        apiKeySet: !!API_KEY,
        cookieSet: !!ROBLOSECURITY
    });
});

// Create T-shirts
app.post('/create-tshirt', upload.single('image'), async (req, res) => {
    try {
        if (!API_KEY) {
            return res.json({ success: false, error: 'ROBLOX_API_KEY is not configured.' });
        }
        if (!ROBLOSECURITY) {
            return res.json({ success: false, error: 'ROBLOSECURITY is not configured.' });
        }

        const price = parseInt(req.body.price) || 5;
        let amount = parseInt(req.body.amount) || 1;
        amount = Math.min(amount, 50); // safety cap
        const name = req.body.name || String(price);
        const description = req.body.description || 'T-Shirt';
        const putForSale = req.body.putOnSale !== 'false'; // default true

        // Use uploaded image or fallback to default
        let imageBuffer;
        if (req.file) {
            imageBuffer = fs.readFileSync(req.file.path);
            // Clean up temp file
            try { fs.unlinkSync(req.file.path); } catch {}
        } else if (req.body.imageBase64) {
            // Accept base64 from the frontend
            const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
            imageBuffer = Buffer.from(base64Data, 'base64');
        } else {
            imageBuffer = getDefaultImageBuffer();
        }

        const created = [];

        for (let i = 0; i < amount; i++) {
            try {
                const result = await createTShirt(name, description, imageBuffer);

                // The API returns an operation — we need to poll for the asset ID
                let assetId = null;
                let assetInfo = null;

                if (result.path || result.operationId) {
                    const opId = result.path
                        ? result.path.replace('operations/', '')
                        : result.operationId;
                    assetInfo = await pollOperation(opId);
                    if (assetInfo) {
                        assetId = assetInfo.assetId || assetInfo.moderationResult?.assetId;
                    }
                } else if (result.assetId) {
                    assetId = result.assetId;
                }

                let saleResult = null;
                if (assetId && putForSale && price > 0) {
                    try {
                        // Small delay before trying to put on sale
                        await new Promise(r => setTimeout(r, 1000));
                        saleResult = await putOnSale(assetId, price);
                    } catch (saleErr) {
                        saleResult = { error: saleErr.response?.data || saleErr.message };
                    }
                }

                created.push({
                    index: i + 1,
                    assetId: assetId || 'pending',
                    operationPath: result.path || null,
                    onSale: saleResult && !saleResult.error,
                    saleError: saleResult?.error || null,
                    name
                });

            } catch (err) {
                console.error(`T-shirt ${i + 1} creation error:`, err.response?.data || err.message);
                created.push({
                    index: i + 1,
                    error: err.response?.data?.message || err.response?.data || err.message
                });
            }
        }

        return res.json({
            success: true,
            totalCreated: created.filter(t => !t.error).length,
            tshirts: created
        });

    } catch (err) {
        console.error('General route error:', err.response?.data || err.message);
        return res.json({
            success: false,
            error: err.response?.data?.message || err.response?.data || err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`T-Shirt Maker running on port ${PORT}`);
    console.log(`Mode: ${GROUP_ID ? 'Group (' + GROUP_ID + ')' : 'User'}`);
    console.log(`API Key set: ${!!API_KEY}`);
    console.log(`Cookie set: ${!!ROBLOSECURITY}`);
});
