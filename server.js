const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt'); // Secure hashing
const multer = require('multer'); // Image Upload Engine
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());
app.use(express.json());

// --- CLOUDINARY IMAGE UPLOAD ENGINE ---
cloudinary.config({ 
  cloud_name: 'djaowcwey', 
  api_key: '129474952763274', // <-- PASTE YOUR API KEY HERE
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

// Keep local uploads folder static route just in case old products use it
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- DATABASE CONNECTION ---
const db = mysql.createConnection({
    host: '77.37.35.4', 
    user: 'u517294510_neonix',
    password: 'Shittylife101@',
    database: 'u517294510_neonix'
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed.', err);
        return;
    }
    console.log('Connected to MySQL Database');
});

// --- CATEGORIES API ---
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
    const { id } = req.params;
    db.query('DELETE FROM categories WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ message: 'Category deleted' });
    });
});

// --- PRODUCTS API ---
app.get('/api/products', (req, res) => {
    db.query('SELECT id, name, category, selling_price AS price, quantity AS stock, alert_quantity, image_url FROM products ORDER BY name ASC', (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error fetching products' });
        res.json(results);
    });
});

// POST: Add a New Product 
app.post('/api/products', upload.single('image'), (req, res) => {
    const name = req.body.name;
    const category = req.body.category;
    const sellingPrice = req.body.selling_price || req.body.sellingPrice;
    const quantity = req.body.quantity || req.body.stock || 0;
    const alertQuantity = req.body.alert_quantity || req.body.alertQuantity || 5;
    
    // Grab the permanent Cloudinary URL
    const imageUrl = req.file ? req.file.path : null;
    
    if (!name || !category || !sellingPrice) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const query = `INSERT INTO products (name, category, selling_price, quantity, alert_quantity, image_url) VALUES (?, ?, ?, ?, ?, ?)`;
    const values = [name, category, sellingPrice, quantity, alertQuantity, imageUrl];

    db.query(query, values, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.status(201).json({ message: 'Product added successfully', id: results.insertId });
    });
});

// PUT: Edit Existing Product 
app.put('/api/products/:id', upload.single('image'), (req, res) => {
    const name = req.body.name;
    const category = req.body.category;
    const sellingPrice = req.body.selling_price || req.body.sellingPrice;
    const alertQuantity = req.body.alert_quantity || req.body.alertQuantity;

    let query = "UPDATE products SET name = ?, category = ?, selling_price = ?, alert_quantity = ? WHERE id = ?";
    let params = [name, category, sellingPrice, alertQuantity, req.params.id];

    // If a new image was uploaded to Cloudinary, update the URL
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

// --- ADVANCED POS CHECKOUT API ---
app.post('/api/checkout', (req, res) => {
    const { cart, totalAmount, type } = req.body;

    if (!cart || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const transQuery = `INSERT INTO transactions (type, total_amount, items) VALUES (?, ?, ?)`;
    db.query(transQuery, [type || 'Sale', totalAmount, JSON.stringify(cart)], (err, result) => {
        if (err) return res.status(500).json({ error: 'Failed to record transaction' });

        let updateCount = 0;
        cart.forEach(item => {
            const updateQuery = `UPDATE products SET quantity = quantity - ? WHERE id = ?`;
            db.query(updateQuery, [item.quantity, item.id], (updateErr) => {
                if (updateErr) console.error(`Failed to update stock for item ${item.id}`);
                updateCount++;
                if (updateCount === cart.length) {
                    res.status(200).json({ message: 'Checkout successful', transactionId: result.insertId });
                }
            });
        });
    });
});

// Smart Edit Checkout (Atomic Swap)
app.post('/api/checkout/edit', (req, res) => {
    const { originalTxId, cart, totalAmount, type } = req.body;

    if (!cart || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    db.query("SELECT * FROM transactions WHERE id = ?", [originalTxId], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ error: 'Original transaction not found' });

        const oldTx = results[0];
        if (oldTx.type === 'Void') return res.status(400).json({ error: 'Original transaction is already voided' });

        const oldItems = typeof oldTx.items === 'string' ? JSON.parse(oldTx.items) : oldTx.items;

        let restoreCount = 0;
        oldItems.forEach(item => {
            db.query("UPDATE products SET quantity = quantity + ? WHERE id = ?", [item.quantity, item.id], () => {
                restoreCount++;
                if (restoreCount === oldItems.length) {
                    db.query("UPDATE transactions SET type = 'Void', total_amount = 0 WHERE id = ?", [originalTxId], () => {
                        db.query("INSERT INTO transactions (type, total_amount, items) VALUES (?, ?, ?)", [type || 'Sale', totalAmount, JSON.stringify(cart)], (insertErr, insertRes) => {
                            let deductCount = 0;
                            cart.forEach(newItem => {
                                db.query("UPDATE products SET quantity = quantity - ? WHERE id = ?", [newItem.quantity, newItem.id], () => {
                                    deductCount++;
                                    if (deductCount === cart.length) {
                                        res.status(200).json({ message: 'Edit successful', newTxId: insertRes.insertId });
                                    }
                                });
                            });
                        });
                    });
                }
            });
        });
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

// --- TRANSACTIONS & DASHBOARD API ---
app.get('/api/dashboard', (req, res) => {
    const stats = {};
    db.query("SELECT SUM(total_amount) as revenue FROM transactions WHERE DATE(transaction_date) = CURDATE() AND type = 'Sale'", (err, revRes) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        stats.todayRevenue = revRes[0].revenue || 0;
        db.query("SELECT COUNT(*) as lowStock FROM products WHERE quantity <= alert_quantity", (err, stockRes) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            stats.lowStockCount = stockRes[0].lowStock || 0;
            db.query("SELECT SUM(quantity * selling_price) as valuation FROM products", (err, valRes) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                stats.totalValuation = valRes[0].valuation || 0;
                db.query("SELECT id, type, total_amount, DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') as time, items FROM transactions ORDER BY transaction_date DESC LIMIT 100", (err, transRes) => {
                    if (err) return res.status(500).json({ error: 'Database error' });
                    stats.recentTransactions = transRes || [];
                    res.json(stats);
                });
            });
        });
    });
});

app.get('/api/transactions', (req, res) => {
    db.query("SELECT id, type, total_amount, DATE_FORMAT(transaction_date, '%Y-%m-%d %H:%i') as time, items FROM transactions ORDER BY transaction_date DESC", (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
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

// --- RESTOCK LEDGER API ---
app.get('/api/restock/history', (req, res) => {
    db.query("SELECT * FROM stock_history ORDER BY restock_date DESC LIMIT 200", (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error fetching history' });
        res.json(results);
    });
});

app.post('/api/restock', (req, res) => {
    const { batchId, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items to restock' });

    let completed = 0;
    let hasError = false;

    items.forEach(item => {
        db.query("UPDATE products SET quantity = quantity + ? WHERE id = ?", [item.quantity, item.id], (err) => {
            if (err) hasError = true;
            db.query("INSERT INTO stock_history (batch_id, product_id, product_name, quantity_added) VALUES (?, ?, ?, ?)", 
            [batchId, item.id, item.name, item.quantity], (err2) => {
                if (err2) hasError = true;
                completed++;
                if (completed === items.length) {
                    if (hasError) return res.status(500).json({ error: 'Batch processed with some errors' });
                    res.status(200).json({ message: 'Batch processed successfully' });
                }
            });
        });
    });
});

// --- SECURE USER MANAGEMENT & AUTHENTICATION ---
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

app.post('/api/users', async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, hashedPassword, role || 'Cashier'], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Username already exists' });
                return res.status(500).json({ error: 'Database error' });
            }
            res.status(201).json({ message: 'User created successfully' });
        });
    } catch (error) {
        res.status(500).json({ error: 'Encryption failed' });
    }
});

app.get('/api/users', (req, res) => {
    db.query("SELECT id, username, role, created_at FROM users ORDER BY created_at DESC", (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

app.delete('/api/users/:id', (req, res) => {
    db.query("DELETE FROM users WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ message: 'User deleted' });
    });
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});