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
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.ROBLOX_API_KEY;
const GROUP_ID = process.env.GROUP_ID || null;
const USER_ID = process.env.USER_ID || null;

// --- Default 1x1 placeholder PNG ---
function getDefaultImageBuffer() {
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    return Buffer.from(base64Png, 'base64');
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
    } else if (USER_ID) {
        requestBody.creationContext.creator.userId = parseInt(USER_ID);
    } else {
        throw new Error('Set either USER_ID or GROUP_ID in your environment variables.');
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

// ===== ROUTES =====

app.get('/status', async (req, res) => {
    res.json({
        success: true,
        mode: GROUP_ID ? 'group' : 'user',
        groupId: GROUP_ID || null,
        userId: USER_ID || null,
        apiKeySet: !!API_KEY
    });
});

app.post('/create-tshirt', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.json({ success: false, error: 'ROBLOX_API_KEY is not configured.' });
        }
        if (!USER_ID && !GROUP_ID) {
            return res.json({ success: false, error: 'Set USER_ID or GROUP_ID in environment variables.' });
        }

        let amount = parseInt(req.body.amount) || 1;
        amount = Math.min(amount, 50);
        const name = req.body.name || 'T-Shirt';
        const description = req.body.description || 'T-Shirt';

        // Use uploaded base64 image or fallback to default
        let imageBuffer;
        if (req.body.imageBase64) {
            const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
            imageBuffer = Buffer.from(base64Data, 'base64');
        } else {
            imageBuffer = getDefaultImageBuffer();
        }

        const created = [];

        for (let i = 0; i < amount; i++) {
            try {
                const result = await createTShirt(name, description, imageBuffer);

                let assetId = null;

                if (result.path || result.operationId) {
                    const opId = result.path
                        ? result.path.replace('operations/', '')
                        : result.operationId;
                    const assetInfo = await pollOperation(opId);
                    if (assetInfo) {
                        assetId = assetInfo.assetId || null;
                    }
                } else if (result.assetId) {
                    assetId = result.assetId;
                }

                created.push({
                    index: i + 1,
                    assetId: assetId || 'pending',
                    name
                });

            } catch (err) {
                console.error(`T-shirt ${i + 1} error:`, err.response?.data || err.message);
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
        console.error('General error:', err.response?.data || err.message);
        return res.json({
            success: false,
            error: err.response?.data?.message || err.response?.data || err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`T-Shirt Maker running on port ${PORT}`);
    console.log(`Mode: ${GROUP_ID ? 'Group (' + GROUP_ID + ')' : 'User (' + (USER_ID || 'NOT SET') + ')'}`);
    console.log(`API Key set: ${!!API_KEY}`);
});
