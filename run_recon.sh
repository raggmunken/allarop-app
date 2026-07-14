set +e
declare -A SITES=(
  [klaravik]="https://www.klaravik.se/"
  [blinto]="https://www.blinto.se/"
  [netauktion]="https://www.netauktion.se/"
  [bukowskis]="https://www.bukowskis.com/sv"
  [sajab]="https://www.sajab.se/"
  [tradera]="https://www.tradera.com/"
  [auktiona]="https://auktiona.se/auktioner"
)
for name in "${!SITES[@]}"; do
  echo "===== $name : ${SITES[$name]} ====="
  timeout 90 npx tsx src/recon/verify.ts "${SITES[$name]}" >"recon-output/log_$name.txt" 2>&1
  echo "  klar ($name), exit $?"
done
echo "BATCH1 KLAR"
