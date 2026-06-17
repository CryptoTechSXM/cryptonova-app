# fund-faucet.ps1
# Pre-loads the Telegram faucet wallet with testnet USDC by calling
# MockUSDC.mint() via the deployer key (owner-only function).
#
# Run this once before deploying the faucet feature, and again whenever
# the faucet wallet balance runs low.
#
# Requirements:
#   - $env:DEPLOYER_PRIVATE_KEY  — deployer key (owns MockUSDC, can mint)
#   - $env:FAUCET_PRIVATE_KEY    — faucet wallet key (we just need its address)
#   - Node.js installed
#   - cd CryptoNita-Smart-Contracts && npm install  (ethers available)
#
# Usage:
#   $env:DEPLOYER_PRIVATE_KEY = "0x..."   # only if not already in .env
#   $env:FAUCET_PRIVATE_KEY   = "0x..."   # only if not already set
#   .\fund-faucet.ps1
# ─────────────────────────────────────────────────────────────────────────────

$deployer = $env:DEPLOYER_PRIVATE_KEY
$faucetKey = $env:FAUCET_PRIVATE_KEY

if (-not $deployer) {
    # Try loading from smart-contracts .env
    $envFile = "C:\CryptoNite-Smart-Contracts\CryptoNova\.env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match "^DEPLOYER_PRIVATE_KEY\s*=\s*(.+)$") {
                $deployer = $Matches[1].Trim().Trim('"')
            }
        }
    }
}
if (-not $deployer) {
    Write-Host "ERROR: DEPLOYER_PRIVATE_KEY not set and not found in .env" -ForegroundColor Red
    exit 1
}
if (-not $faucetKey) {
    Write-Host "ERROR: FAUCET_PRIVATE_KEY is not set." -ForegroundColor Red
    Write-Host "Create a new wallet (e.g. in MetaMask) and set its private key as FAUCET_PRIVATE_KEY." -ForegroundColor Yellow
    exit 1
}

# Write a temp Node script that mints USDC to the faucet wallet
$script = @"
import { ethers } from 'ethers';

const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const FAUCET_KEY   = process.env.FAUCET_KEY;
const RPC_URL      = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const USDC_ADDRESS = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const MINT_AMOUNT  = 10_000_000_000n; // 10,000 USDC (6 decimals)

const provider  = new ethers.JsonRpcProvider(RPC_URL);
const deployer  = new ethers.Wallet(DEPLOYER_KEY, provider);
const faucetAddr = new ethers.Wallet(FAUCET_KEY).address;

const usdc = new ethers.Contract(USDC_ADDRESS, [
  'function mint(address to, uint256 amount) external',
  'function balanceOf(address account) view returns (uint256)',
], deployer);

console.log('Deployer:', deployer.address);
console.log('Faucet wallet:', faucetAddr);

const before = await usdc.balanceOf(faucetAddr);
console.log('Faucet USDC before:', (Number(before) / 1e6).toFixed(2));

console.log('Minting 10,000 USDC to faucet wallet...');
const tx = await usdc.mint(faucetAddr, MINT_AMOUNT);
const receipt = await tx.wait(1);
console.log('TX hash:', receipt.hash);

const after = await usdc.balanceOf(faucetAddr);
console.log('Faucet USDC after:', (Number(after) / 1e6).toFixed(2));
console.log('Done! Faucet wallet is ready.');
"@

$tmpScript = [System.IO.Path]::GetTempFileName() + ".mjs"
$script | Out-File -FilePath $tmpScript -Encoding UTF8

Write-Host ""
Write-Host "Minting 10,000 testnet USDC to faucet wallet..." -ForegroundColor Cyan
Write-Host ""

$env:DEPLOYER_KEY    = $deployer
$env:FAUCET_KEY      = $faucetKey
# BASE_SEPOLIA_RPC passes through if already set

# Run from smart-contracts dir so ethers is resolvable (already npm-installed there)
$prevDir = Get-Location
Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"
node $tmpScript
Set-Location $prevDir

Remove-Item $tmpScript -Force

Write-Host ""
Write-Host "Faucet wallet funded. Add these vars to Vercel:" -ForegroundColor Green
Write-Host "  FAUCET_PRIVATE_KEY = <your faucet key>" -ForegroundColor White
Write-Host "  BASE_SEPOLIA_RPC   = <your Alchemy URL>" -ForegroundColor White
Write-Host ""
