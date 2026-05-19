!macro customInstall
  DetailPrint "Removing old Chunknet P2P firewall rules if they exist..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Chunknet P2P 8787"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Chunknet P2P Outbound"'

  DetailPrint "Adding Chunknet P2P inbound firewall rule..."
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Chunknet P2P 8787" dir=in action=allow protocol=TCP localport=8787 profile=private,domain'

  DetailPrint "Adding Chunknet P2P outbound firewall rule..."
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Chunknet P2P Outbound" dir=out action=allow protocol=TCP localport=8787 profile=private,domain'
!macroend

!macro customUnInstall
  DetailPrint "Removing Chunknet P2P firewall rules..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Chunknet P2P 8787"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Chunknet P2P Outbound"'
!macroend
