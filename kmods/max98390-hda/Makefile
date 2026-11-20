# MAX98390 HDA side-codec driver (speakers), out of tree. Built by kmods/build.sh against the image kernel.
KVER ?= $(shell uname -r)
KDIR ?= /lib/modules/$(KVER)/build

obj-m += snd-hda-scodec-max98390.o
obj-m += snd-hda-scodec-max98390-i2c.o
snd-hda-scodec-max98390-y := max98390_hda.o max98390_hda_filters.o max98390_hda_windows.o
snd-hda-scodec-max98390-i2c-y := max98390_hda_i2c.o

all:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules
clean:
	$(MAKE) -C $(KDIR) M=$(CURDIR) clean
