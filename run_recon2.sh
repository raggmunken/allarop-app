set +e
declare -A SITES=(
  [blinto2]="https://www.blinto.se/auction/Volvo-L90F-267984-194806/"
  [bukowskis2]="https://www.bukowskis.com/sv/lots"
  [tradera2]="https://www.tradera.com/category/20"
  [klaravik2]="https://www.klaravik.se/auktioner"
  [netauktion2]="https://www.netauktion.se/auktioner"
)
for name in "${!SITES[@]}"; do
  echo "===== $name : ${SITES[$name]} ====="
  timeout 90 npx tsx src/recon/verify.ts "${SITES[$name]}" >"recon-output/log_$name.txt" 2>&1
  echo "  klar ($name) exit $?"
done
echo "BATCH2 KLAR"
