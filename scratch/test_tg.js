import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.trading' });

async function test() {
    const tokens = [
        { name: 'Scalper', token: process.env.TELEGRAM_TOKEN },
        { name: 'Miner', token: process.env.FUNDING_TELEGRAM_TOKEN }
    ];
    const chatId = process.env.TELEGRAM_CHAT_ID;

    for (const t of tokens) {
        if (!t.token) {
            console.log(`❌ ${t.name}: Token não encontrado no .env`);
            continue;
        }
        try {
            const bot = new TelegramBot(t.token);
            await bot.sendMessage(chatId, `o. Teste de Conexǜo do Sistema Alpha Scanner (${t.name}) - Status: OK`);
            console.log(`✅ ${t.name}: Mensagem enviada com sucesso!`);
        } catch (e) {
            console.log(`❌ ${t.name}: Erro - ${e.message}`);
        }
    }
}
test();
