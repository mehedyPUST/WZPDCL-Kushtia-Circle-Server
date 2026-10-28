// add-admin.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const readline = require('readline');

// Create readline interface for password input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Configuration - Get from environment or use default
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://mehedyWZPDCL:KXC1je7M1GpVhi0q@cluster-mehedywzpdcl.ep7uqwu.mongodb.net/load-calculator?appName=cluster-mehedyWZPDCL';

// Function to prompt for input
function prompt(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

async function addAdmin() {
    try {
        console.log('\n========================================');
        console.log('  WZPDCL Admin User Creator');
        console.log('========================================\n');

        // Get admin details from user
        const username = await prompt('Enter username: ');
        if (!username) {
            console.log('❌ Username is required');
            process.exit(1);
        }

        const password = await prompt('Enter password: ');
        if (!password || password.length < 8) {
            console.log('❌ Password must be at least 8 characters');
            process.exit(1);
        }

        const email = await prompt('Enter email: ');
        if (!email || !email.includes('@')) {
            console.log('❌ Valid email is required');
            process.exit(1);
        }

        const roleInput = await prompt('Enter role (admin/superadmin) [default: admin]: ');
        const role = roleInput || 'admin';

        console.log('\n📝 Creating admin with:');
        console.log(`   Username: ${username}`);
        console.log(`   Email: ${email}`);
        console.log(`   Role: ${role}`);
        console.log('');

        const confirm = await prompt('Continue? (y/N): ');
        if (confirm.toLowerCase() !== 'y') {
            console.log('❌ Admin creation cancelled.');
            process.exit(0);
        }

        console.log('\n🔄 Connecting to MongoDB...');

        // Connect with better options
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        console.log('✅ Connected to MongoDB');

        // Define Admin Schema
        const adminSchema = new mongoose.Schema({
            username: { type: String, required: true, unique: true },
            password: { type: String, required: true },
            email: { type: String, required: true, unique: true },
            role: { type: String, enum: ['admin', 'superadmin'], default: 'admin' },
            lastLogin: { type: Date, default: null },
            isActive: { type: Boolean, default: true },
        }, { timestamps: true });

        // Check if model exists, if not create it
        let Admin;
        try {
            Admin = mongoose.model('Admin');
        } catch {
            Admin = mongoose.model('Admin', adminSchema);
        }

        // Check if admin exists
        console.log('🔍 Checking for existing admins...');
        const existing = await Admin.findOne({
            $or: [{ username: username }, { email: email }]
        });

        if (existing) {
            console.log('⚠️  Admin already exists:');
            console.log(`   Username: ${existing.username}`);
            console.log(`   Email: ${existing.email}`);
            console.log(`   Role: ${existing.role}`);
            console.log(`   Active: ${existing.isActive}`);
            process.exit(0);
        }

        // Hash password
        console.log('🔐 Hashing password...');
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create admin
        console.log('📝 Creating admin user...');
        const admin = new Admin({
            username,
            password: hashedPassword,
            email,
            role: role === 'superadmin' ? 'superadmin' : 'admin',
            isActive: true,
        });

        await admin.save();

        console.log('\n✅ Admin created successfully!');
        console.log('========================================');
        console.log('🔑 Login Credentials:');
        console.log(`   Username: ${username}`);
        console.log(`   Email: ${email}`);
        console.log(`   Role: ${role}`);
        console.log(`   Password: [hidden]`);
        console.log('========================================\n');

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.log('\n🔧 Troubleshooting:');
        console.log('   1. Check your MongoDB Atlas connection string');
        console.log('   2. Make sure your IP is whitelisted in Atlas');
        console.log('   3. Verify the database user has correct permissions');
        console.log('   4. Check if the cluster is active');
        console.log('\n📝 Your connection string should look like:');
        console.log('   mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/DATABASE?appName=APPNAME');
        process.exit(1);
    } finally {
        rl.close();
    }
}

addAdmin();