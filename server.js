const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();

// 1. IMPROVED CORS
app.use(cors({
    origin: ['https://henkdiesel.store', 'https://www.henkdiesel.store', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// --- CLOUDINARY IMAGE UPLOAD ENGINE ---
cloudinary.config({ 
  cloud_name: 'djaowcwey', 
  api_key: '129474952763274',
  api_secret: 'BHaM5pezyqvV9wEOYXFFjYmfy5M' 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'neonix_pos',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp']
  },
});
const upload = multer({ storage: storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 2. DATABASE CONNECTION
const db = mysql.createPool({
    host: '77.37.35.4', 
    user: 'u517294510_neonix',
    password: 'Shittylife101@', 
    database: 'u517294510_neonix',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true, 
    keepAliveInitialDelay: 10000
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed:', err.message);
    } else {
        console.log('Connected to MySQL via Pool');
        connection.release();
    }
});

// --- API ROUTES ---

app.get('/api/categories', (req, res) => {
    db.query('SELECT * FROM categories ORDER BY name ASC', (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

app.post('/api/categories', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    db.query('INSERT INTO categories (name) VALUES (?)', [name], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.status(201).json({ id: results.insertId, name });
    });
});

app.delete('/api/categories/:id', (req, res) => {
    db.query('DELETE FROM categories WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ message: 'Category deleted' });
    });
});

app.get('/api/products', (req, res) => {
    db.query('SELECT id, name, category, selling_price AS price, quantity AS stock, alert_quantity, image_url FROM products ORDER BY name ASC', (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error fetching products' });
        res.json(results);
    });
});

app.post('/api/products', upload.single('image'), (req, res) => {
    const { name, category } = req.body;
    const sellingPrice = req.body.selling_price || req.body.sellingPrice;
    const quantity = req.body.quantity || req.body.stock || 0;
    const alertQuantity = req.body.alert_quantity || req.body.alertQuantity || 5;
    const imageUrl = req.file ? req.file.path : null;
    
    if (!name || !category || !sellingPrice) return res.status(400).json({ error: 'Missing required fields' });

    const query = `INSERT INTO products (name, category, selling_price, quantity, alert_quantity, image_url) VALUES (?, ?, ?, ?, ?, ?)`;
    db.query(query, [name, category, sellingPrice, quantity, alertQuantity, imageUrl], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.status(201).json({ message: 'Product added successfully', id: results.insertId });
    });
});

app.put('/api/products/:id', upload.single('image'), (req, res) => {
    const { name, category } = req.body;
    const sellingPrice = req.body.selling_price || req.body.sellingPrice;
    const alertQuantity = req.body.alert_quantity || req.body.alertQuantity;
    let query = "UPDATE products SET name = ?, category = ?, selling_price = ?, alert_quantity = ? WHERE id = ?";
    let params = [name, category, sellingPrice, alertQuantity, req.params.id];

    if (req.file) {
        query = "UPDATE products SET name = ?, category = ?, selling_price = ?, alert_quantity = ?, image_url = ? WHERE id = ?";
        params = [name, category, sellingPrice, alertQuantity, req.file.path, req.params.id];
    }

    db.query(query, params, (err) => {
        if (err) return res.status(500).json({ error: 'Database error updating product' });
        res.json({ message: 'Product updated successfully' });
    });
});

app.delete('/api/products/:id', (req, res) => {
    const productId = req.params.id;
    db.query("DELETE FROM stock_history WHERE product_id = ?", [productId], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to clear product history' });
        db.query("DELETE FROM products WHERE id = ?", [productId], (err2) => {
            if (err2) return res.status(500).json({ error: 'Failed to delete product' });
            res.json({ message: 'Product deleted permanently' });
        });
    });
});

app.post('/api/checkout', (req, res) => {
    const { cart, totalAmount, type } = req.body;
    if (!cart || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const itemIds = cart.map(item => item.id);
    db.query('SELECT id, name, quantity FROM products WHERE id IN (?)', [itemIds], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error checking inventory' });

        let insufficientItem = null;
        for (const cartItem of cart) {
            const dbItem = results.find(p => p.id === cartItem.id);
            if (!dbItem || dbItem.quantity < cartItem.quantity) {
                insufficientItem = dbItem ? dbItem.name : `Item ID ${cartItem.id}`;
                break;
            }
        }

        if (insufficientItem) {
            return res.status(400).json({ error: `Not enough stock for ${insufficientItem}. Checkout aborted.` });
        }

        const transQuery = `INSERT INTO transactions (type, total_amount, items) VALUES (?, ?, ?)`;
        db.query(transQuery, [type || 'Sale', totalAmount, JSON.stringify(cart)], (err, result) => {
            if (err) return res.status(500).json({ error: 'Failed to record transaction' });
            
            let updateCount = 0;
            cart.forEach(item => {
                db.query(`UPDATE products SET quantity = quantity - ? WHERE id = ?`, [item.quantity, item.id], (upErr) => {
                    updateCount++;
                    if (updateCount === cart.length) {
                        res.status(200).json({ message: 'Checkout successful', transactionId: result.insertId });
                    }
                });
            });
        });
    });
});

// ==========================================
// --- RESTOCK & SHIPMENTS API (NEW TABLE) ---
// ==========================================

// 1. Record a new shipment directly into the 'shipments' table
app.post('/api/restock', (req, res) => {
    const { items, batchId } = req.body; 
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in shipment' });

    // Use provided batchId from frontend, or generate a fallback
    const finalBatchId = batchId || `RCV-${Date.now().toString().slice(-6)}`;

    const query = `INSERT INTO shipments (batch_id, items) VALUES (?, ?)`;
    db.query(query, [finalBatchId, JSON.stringify(items)], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to record shipment' });
        
        let updateCount = 0;
        let hasError = false;

        items.forEach(item => {
            // Add stock (+) to inventory
            db.query(`UPDATE products SET quantity = quantity + ? WHERE id = ?`, [item.quantity, item.id], (upErr) => {
                if (upErr) hasError = true;
                updateCount++;
                
                if (updateCount === items.length) {
                    if (hasError) return res.status(500).json({ error: 'Shipment saved but some stock failed to update' });
                    res.status(200).json({ message: 'Shipment recorded successfully', shipmentId: result.insertId });
                }
            });
        });
    });
});

// 2. Fetch shipment history for the Purchases Ledger
app.get('/api/restock/history', (req, res) => {
    db.query("SELECT id, batch_id, created_at, items FROM shipments ORDER BY created_at DESC", (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error fetching shipment history' });

        let history = [];
        results.forEach(shipment => {
            const items = typeof shipment.items === 'string' ? JSON.parse(shipment.items) : shipment.items;
            items.forEach(item => {
                history.push({
                    batch_id: shipment.batch_id,
                    restock_date: shipment.created_at,
                    product_name: item.name,
                    quantity_added: item.quantity,
                    id: shipment.id + '-' + item.id 
                });
            });
        });
        res.json(history);
    });
});

// ==========================================
// --- TRANSACTIONS API (PURE SALES ONLY) ---
// ==========================================

// 1. Fetch all transactions (Now guaranteed to only be pure sales/voids)
app.get('/api/transactions', (req, res) => {
    db.query("SELECT id, type, total_amount, DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') as time, items FROM transactions ORDER BY transaction_date DESC", (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error fetching transactions' });
        res.json(results);
    });
});

app.get('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    db.query("SELECT * FROM transactions WHERE id = ?", [id], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (results.length === 0) return res.status(404).json({ error: 'Transaction not found' });
        res.json(results[0]);
    });
});

// 3. True Delete (Erases Sale completely and restores stock)
app.delete('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    
    db.query("SELECT * FROM transactions WHERE id = ?", [id], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ error: 'Transaction not found' });
        
        const transaction = results[0];
        
        if (transaction.type === 'Void') {
            db.query("DELETE FROM transactions WHERE id = ?", [id], (delErr) => {
                if (delErr) return res.status(500).json({ error: 'Failed to delete record' });
                return res.json({ message: 'Voided record completely removed' });
            });
        } 
        else {
            const items = typeof transaction.items === 'string' ? JSON.parse(transaction.items) : transaction.items;
            let completed = 0;
            let hasError = false;

            // Since this table is ONLY sales now, we always ADD stock back when deleting a transaction
            items.forEach(item => {
                db.query("UPDATE products SET quantity = quantity + ? WHERE id = ?", [item.quantity, item.id], (updateErr) => {
                    if (updateErr) hasError = true;
                    completed++;
                    
                    if (completed === items.length) {
                        db.query("DELETE FROM transactions WHERE id = ?", [id], (delErr) => {
                            if (delErr || hasError) return res.status(500).json({ error: 'Deletion processed with errors' });
                            res.json({ message: 'Transaction erased and stock restored' });
                        });
                    }
                });
            });
        }
    });
});

app.post('/api/transactions/:id/void', (req, res) => {
    const { id } = req.params;
    db.query("SELECT * FROM transactions WHERE id = ?", [id], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ error: 'Transaction not found' });
        
        const transaction = results[0];
        if (transaction.type === 'Void') return res.status(400).json({ error: 'Already voided' });
        
        const items = typeof transaction.items === 'string' ? JSON.parse(transaction.items) : transaction.items;
        let completed = 0;
        let hasError = false;

        items.forEach(item => {
            db.query("UPDATE products SET quantity = quantity + ? WHERE id = ?", [item.quantity, item.id], (updateErr) => {
                if (updateErr) hasError = true;
                completed++;
                if (completed === items.length) {
                    db.query("UPDATE transactions SET type = 'Void', total_amount = 0 WHERE id = ?", [id], (voidErr) => {
                        if (voidErr || hasError) return res.status(500).json({ error: 'Void processed with errors' });
                        res.json({ message: 'Transaction voided', items: items }); 
                    });
                }
            });
        });
    });
});
// ==========================================
// --- STORE SETTINGS API (RBAC TOGGLES) ---
// ==========================================

// 1. Get all settings
app.get('/api/settings', (req, res) => {
    db.query("SELECT setting_key, setting_value FROM store_settings", (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error fetching settings' });
        
        // Convert MySQL tinyint (1/0) back to true/false for React
        const settings = {};
        results.forEach(row => {
            settings[row.setting_key] = row.setting_value === 1;
        });
        res.json(settings);
    });
});

// 2. Update a specific setting
app.put('/api/settings', (req, res) => {
    const { key, value } = req.body;
    
    // Convert React true/false to MySQL 1/0
    const intValue = value ? 1 : 0;
    
    db.query("UPDATE store_settings SET setting_value = ? WHERE setting_key = ?", [intValue, key], (err) => {
        if (err) return res.status(500).json({ error: 'Database error updating settings' });
        res.json({ message: 'Setting updated successfully' });
    });
});


// ==========================================
// --- STORE SETTINGS API (RBAC TOGGLES) ---
// ==========================================

app.get('/api/settings', (req, res) => {
    db.query("SELECT setting_key, setting_value FROM store_settings", (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error fetching settings' });
        
        const settings = {};
        results.forEach(row => {
            settings[row.setting_key] = row.setting_value === 1;
        });
        res.json(settings);
    });
});

app.put('/api/settings', (req, res) => {
    const { key, value } = req.body;
    const intValue = value ? 1 : 0;
    
    db.query("UPDATE store_settings SET setting_value = ? WHERE setting_key = ?", [intValue, key], (err) => {
        if (err) return res.status(500).json({ error: 'Database error updating settings' });
        res.json({ message: 'Setting updated successfully' });
    });
});
// --- DASHBOARD & AUTH ---

app.get('/api/dashboard', (req, res) => {
    const stats = {};
    db.query("SELECT SUM(total_amount) as revenue FROM transactions WHERE DATE(transaction_date) = CURDATE() AND type = 'Sale'", (err, revRes) => {
        stats.todayRevenue = revRes[0]?.revenue || 0;
        
        // FIXED BUG: Added "AND alert_quantity > 0" so items with a 0 threshold are ignored
        db.query("SELECT COUNT(*) as lowStock FROM products WHERE quantity <= alert_quantity AND alert_quantity > 0", (err, stockRes) => {
            stats.lowStockCount = stockRes[0]?.lowStock || 0;
            
            db.query("SELECT SUM(quantity * selling_price) as valuation FROM products", (err, valRes) => {
                stats.totalValuation = valRes[0]?.valuation || 0;
                // Cleaned up query, no more 'Shipment' filter needed here!
                db.query("SELECT id, type, total_amount, DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') as time, items FROM transactions ORDER BY transaction_date DESC LIMIT 100", (err, transRes) => {
                    stats.recentTransactions = transRes || [];
                    res.json(stats);
                });
            });
        });
    });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.query("SELECT id, username, password, role FROM users WHERE username = ?", [username], async (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (results.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });
        delete user.password; 
        res.json(user); 
    });
});

const PORT = process.env.PORT || 10000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
